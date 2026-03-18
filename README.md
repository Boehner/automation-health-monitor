# Automation Health Monitor

Monitor any website for structural changes — CTAs, word count, tech stack — using the [SnapAPI](https://snapapi.tech) analyze endpoint. Get alerted when a competitor changes their pricing page, removes a CTA, or rewrites their homepage.

Zero npm dependencies. Node.js 18+ only.

---

## What it does

Each run, the monitor:

1. Reads `config.json` — your list of URLs to watch
2. Calls SnapAPI's `/v1/analyze` endpoint for each URL
3. Compares the result against the last saved snapshot
4. Prints `[ALERT]` if anything changed (CTA text, word count >10%, tech stack), or `[OK]` if unchanged
5. Saves the latest snapshot to `state/` for the next run

---

## Requirements

- **Node.js 18+** — uses built-in `fetch` and `https`; no `npm install` needed
- **SnapAPI API key** — free (100 calls/month) at [snapapi.tech](https://snapapi.tech)

---

## Setup

```bash
git clone https://github.com/Boehner/automation-health-monitor.git
cd automation-health-monitor
export SNAPAPI_KEY=your_api_key_here
```

---

## Config

Edit `config.json` — one entry per URL to monitor:

```json
[
  { "name": "Stripe Pricing",     "url": "https://stripe.com/pricing" },
  { "name": "Competitor Homepage", "url": "https://competitor.com" },
  { "name": "My Pricing Page",    "url": "https://yoursite.com/pricing" }
]
```

- `name` — human-readable label used in alerts and state file names
- `url` — full URL including `https://`

---

## Usage

```bash
SNAPAPI_KEY=your_key node index.js
```

Sample output:

```
[2026-03-18T09:00:00.000Z] automation-health-monitor starting — 3 URLs

Checking: Stripe Pricing (https://stripe.com/pricing) ... [OK] no changes detected
Checking: Notion Pricing (https://notion.so/pricing) ... [OK] no changes detected
Checking: Linear Pricing (https://linear.app/pricing) ...
[ALERT] Linear Pricing: page changed
        • CTA changed: "Start for free" → "Get started free"
        • Word count: 842 → 1104 (31% change)

Done.
```

---

## Cron — Run automatically every 6 hours

```bash
*/360 * * * * SNAPAPI_KEY=your_key node /path/to/automation-health-monitor/index.js >> /var/log/monitor.log 2>&1
```

Or with a GitHub Actions workflow (`.github/workflows/monitor.yml`):

```yaml
on:
  schedule:
    - cron: '0 */6 * * *'
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node index.js
        env:
          SNAPAPI_KEY: ${{ secrets.SNAPAPI_KEY }}
```

---

## How it works

SnapAPI's `/v1/analyze` endpoint runs a real Chromium browser against each URL and returns:

- `cta` / `primary_cta` — the main call-to-action text(s) on the page
- `word_count` — total visible words
- `technologies` — detected frameworks and services (React, Stripe.js, etc.)
- `page_type` — classification of the page

The monitor extracts these fields, stores a snapshot in `state/<name-slug>.json`, and diffs against the previous run. No DOM parsing, no CSS selectors that break when the site redesigns, no Puppeteer to maintain.

---

## Free API Key

**100 calls/month — no credit card required.**

→ [https://snapapi.tech](https://snapapi.tech)

With 3 URLs and 4 checks/day, you'll use ~360 calls/month. The Starter plan ($9/mo) gives you 1,000 calls — enough for ~80 URLs checked daily.

---

## License

MIT
