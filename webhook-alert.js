#!/usr/bin/env node
/**
 * webhook-alert.js — Slack/Discord change notifications for automation-health-monitor
 *
 * Drop-in companion to index.js. Runs the same monitoring logic but POSTs
 * a message to a webhook URL when any monitored page changes.
 * Silence = OK (no webhook fire if nothing changed).
 *
 * Usage:
 *   SNAPAPI_KEY=your_key WEBHOOK_URL=https://hooks.slack.com/... node webhook-alert.js
 *
 * Environment variables:
 *   SNAPAPI_KEY   — your SnapAPI API key (free at https://snapapi.tech)
 *   WEBHOOK_URL   — Slack, Discord, or any compatible incoming webhook URL
 *
 * Cron (every 6 hours):
 *   0 */6 * * * SNAPAPI_KEY=xxx WEBHOOK_URL=https://hooks.slack.com/... node /path/to/webhook-alert.js
 *
 * Requires Node.js 18+ — zero npm dependencies.
 */

'use strict';

const https  = require('node:https');
const fs     = require('node:fs');
const path   = require('node:path');
const { URL } = require('node:url');

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY     = process.env.SNAPAPI_KEY  || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL  || '';
const CONFIG      = path.join(__dirname, '..', 'automation-health-monitor', 'config.json');
const STATE_DIR   = path.join(__dirname, '..', 'automation-health-monitor', 'state');

// Fall back to config.json in the same directory if the sibling repo path doesn't exist
const CONFIG_PATH  = fs.existsSync(CONFIG)  ? CONFIG  : path.join(__dirname, 'config.json');
const STATE_PATH   = fs.existsSync(STATE_DIR) ? STATE_DIR : path.join(__dirname, 'state');

if (!API_KEY) {
  console.error('[ERROR] SNAPAPI_KEY not set. Get a free key at https://snapapi.tech');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('[ERROR] WEBHOOK_URL not set. Set it to your Slack/Discord incoming webhook URL.');
  process.exit(1);
}
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[ERROR] config.json not found at ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (!fs.existsSync(STATE_PATH)) {
  fs.mkdirSync(STATE_PATH, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function analyzeUrl(url) {
  return new Promise((resolve, reject) => {
    const endpoint =
      `https://api.snapapi.tech/v1/analyze?url=${encodeURIComponent(url)}&api_key=${encodeURIComponent(API_KEY)}`;
    const req = https.get(endpoint, { headers: { 'x-api-key': API_KEY } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(body);
            reject(new Error(err.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from SnapAPI')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('SnapAPI timeout')));
  });
}

function extractSnapshot(data) {
  return {
    cta: Array.isArray(data.cta)
      ? data.cta
      : (data.primary_cta ? [data.primary_cta] : []),
    word_count:   data.word_count   ?? 0,
    technologies: Array.isArray(data.technologies) ? data.technologies.sort() : [],
    checked_at:   new Date().toISOString(),
  };
}

function detectChanges(prev, curr) {
  const changes = [];
  const prevCta = prev.cta.join(' | ');
  const currCta = curr.cta.join(' | ');
  if (prevCta !== currCta) {
    changes.push({ field: 'CTAs', old: prevCta || '(none)', new: currCta || '(none)' });
  }
  if (prev.word_count > 0) {
    const delta = Math.abs(curr.word_count - prev.word_count) / prev.word_count;
    if (delta > 0.10) {
      changes.push({
        field: 'Word count',
        old: String(prev.word_count),
        new: `${curr.word_count} (${(delta * 100).toFixed(0)}% change)`,
      });
    }
  }
  const prevTech = prev.technologies.join(', ');
  const currTech = curr.technologies.join(', ');
  if (prevTech !== currTech) {
    changes.push({ field: 'Tech stack', old: prevTech || '(none)', new: currTech || '(none)' });
  }
  return changes;
}

/**
 * POST a Slack-compatible JSON payload to the configured webhook URL.
 * Works with Slack, Discord (use the ?wait=true endpoint), and most
 * webhook-compatible services.
 */
function postWebhook(text) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(WEBHOOK_URL);
    const payload = JSON.stringify({ text });
    const opts    = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      res.resume(); // drain response
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Webhook POST timed out')));
    req.write(payload);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] webhook-alert starting — ${config.length} URLs\n`);

  const alerts = []; // collect all alerts before posting

  for (const entry of config) {
    const { name, url } = entry;
    const stateFile = path.join(STATE_PATH, `${slugify(name)}.json`);

    process.stdout.write(`Checking: ${name} ... `);

    let current;
    try {
      const data = await analyzeUrl(url);
      current = extractSnapshot(data);
    } catch (err) {
      console.log(`\n[ERROR] ${name}: ${err.message}`);
      continue;
    }

    if (fs.existsSync(stateFile)) {
      const prev    = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const changes = detectChanges(prev, current);

      if (changes.length > 0) {
        const lines = [
          `*[automation-health-monitor] ALERT: ${name} changed*`,
          `URL: ${url}`,
          ...changes.map(c => `• ${c.field}: ${c.old} → ${c.new}`),
        ];
        alerts.push(lines.join('\n'));
        console.log(`[ALERT] ${changes.length} change(s)`);
      } else {
        console.log('[OK]');
      }
    } else {
      console.log('[INIT] baseline saved');
    }

    fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));
    await new Promise(r => setTimeout(r, 800));
  }

  // Post all alerts as a single webhook message (avoid spamming)
  if (alerts.length > 0) {
    const message = alerts.join('\n\n---\n\n');
    try {
      await postWebhook(message);
      console.log(`\n[WEBHOOK] Alert posted (${alerts.length} change(s)).`);
    } catch (err) {
      console.error(`\n[WEBHOOK ERROR] Failed to post: ${err.message}`);
    }
  } else {
    console.log('\nNo changes — webhook not triggered.');
  }

  console.log('Done.\n');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
