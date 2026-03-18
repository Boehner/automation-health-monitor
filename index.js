#!/usr/bin/env node
/**
 * automation-health-monitor
 * Monitor websites for structural changes using SnapAPI /v1/analyze.
 *
 * Usage:  SNAPAPI_KEY=your_key node index.js
 * Config: edit config.json to add/remove URLs to monitor.
 *
 * Free SnapAPI key (100 calls/month): https://snapapi.tech
 */

'use strict';

const https  = require('node:https');
const fs     = require('node:fs');
const path   = require('node:path');

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY    = process.env.SNAPAPI_KEY || '';
const CONFIG     = path.join(__dirname, 'config.json');
const STATE_DIR  = path.join(__dirname, 'state');

if (!API_KEY) {
  console.error('[ERROR] SNAPAPI_KEY environment variable is not set.');
  console.error('        Get a free key (100 calls/month) at https://snapapi.tech');
  process.exit(1);
}

if (!fs.existsSync(CONFIG)) {
  console.error(`[ERROR] config.json not found at ${CONFIG}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a monitor name to a safe filename slug. */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Make a GET request to SnapAPI and return parsed JSON. */
function analyzeUrl(url) {
  return new Promise((resolve, reject) => {
    const endpoint =
      `https://api.snapapi.tech/v1/analyze?url=${encodeURIComponent(url)}&api_key=${encodeURIComponent(API_KEY)}`;
    const req = https.get(endpoint, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(body);
            reject(new Error(err.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          }
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON response: ${body.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Request timed out after 30s')));
  });
}

/** Extract the fields we care about from an analyze response. */
function extractSnapshot(data) {
  return {
    // Normalise CTA — handle both 'cta' (array) and 'primary_cta' (string) shapes
    cta: Array.isArray(data.cta)
      ? data.cta
      : (data.primary_cta ? [data.primary_cta] : []),
    word_count:   data.word_count   ?? 0,
    technologies: Array.isArray(data.technologies) ? data.technologies.sort() : [],
    page_type:    data.page_type    ?? '',
    checked_at:   new Date().toISOString(),
  };
}

/** Compare two snapshots and return an array of human-readable change strings. */
function detectChanges(prev, curr) {
  const changes = [];

  // CTA change
  const prevCta = prev.cta.join(' | ');
  const currCta = curr.cta.join(' | ');
  if (prevCta !== currCta) {
    changes.push(`CTA changed: "${prevCta}" → "${currCta}"`);
  }

  // Word count change > 10%
  if (prev.word_count > 0) {
    const delta = Math.abs(curr.word_count - prev.word_count) / prev.word_count;
    if (delta > 0.10) {
      changes.push(`Word count: ${prev.word_count} → ${curr.word_count} (${(delta * 100).toFixed(0)}% change)`);
    }
  }

  // Tech stack change
  const prevTech = prev.technologies.join(', ');
  const currTech = curr.technologies.join(', ');
  if (prevTech !== currTech) {
    changes.push(`Tech stack changed: [${prevTech || 'none'}] → [${currTech || 'none'}]`);
  }

  return changes;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] automation-health-monitor starting — ${config.length} URLs\n`);

  for (const entry of config) {
    const { name, url } = entry;
    const stateFile = path.join(STATE_DIR, `${slugify(name)}.json`);

    process.stdout.write(`Checking: ${name} (${url}) ... `);

    let current;
    try {
      const data = await analyzeUrl(url);
      current = extractSnapshot(data);
    } catch (err) {
      console.log(`\n[ERROR] ${name}: ${err.message}`);
      continue;
    }

    if (fs.existsSync(stateFile)) {
      const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const changes = detectChanges(prev, current);

      if (changes.length > 0) {
        console.log(`\n[ALERT] ${name}: page changed`);
        for (const c of changes) {
          console.log(`        • ${c}`);
        }
      } else {
        console.log(`[OK] no changes detected`);
      }
    } else {
      console.log(`[INIT] baseline saved`);
    }

    // Always persist the latest snapshot
    fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));

    // Small delay between requests — be a good citizen with the API
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
