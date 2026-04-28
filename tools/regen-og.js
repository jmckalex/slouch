#!/usr/bin/env node
/**
 * regen-og.js — clear and regenerate all OG images.
 *
 * Useful after:
 *   - changing the interstitial design/layout
 *   - changing the OG render pipeline (fonts, MathJax, Puppeteer config)
 *   - upgrading puppeteer / chromium
 *
 * Run on the droplet:
 *   cd /var/www/slouch && sudo -u ghostuser node regen-og.js
 *
 * It walks the database for every link/file code, deletes the cached PNG
 * (if any), and asks the local server to regenerate it by hitting
 * /:code/og.png. This means the running service does the work, using the
 * same browser instance — we don't spin up a second Chromium.
 *
 * Sequential, with a small delay between requests, so we don't hammer the
 * single browser instance. Slow but safe.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'slouch.db');
const OG_CACHE_DIR = path.join(__dirname, 'og-cache');
const PORT = process.env.PORT || 3001;
const HOST = '127.0.0.1';
const DELAY_MS = 250; // pause between requests so the single browser keeps up

const db = new Database(DB_PATH, { readonly: true });
const codes = [
  ...db.prepare('SELECT code FROM links').all().map(r => r.code),
  ...db.prepare('SELECT code FROM files').all().map(r => r.code),
];
db.close();

console.log(`Found ${codes.length} codes. Regenerating…`);

function fetchOgPng(code) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path: `/${encodeURIComponent(code)}/og.png`,
      method: 'GET',
      timeout: 30000,
    }, res => {
      // Drain so the connection closes; we don't actually need the bytes.
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  let ok = 0, fail = 0;
  for (const code of codes) {
    // Drop the cache file if it exists, so the request actually triggers a render.
    const cacheFile = path.join(OG_CACHE_DIR, `${code.replace(/[^a-zA-Z0-9_-]/g, '')}.png`);
    try { if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile); } catch {}

    try {
      const status = await fetchOgPng(code);
      if (status === 200) {
        ok++;
        process.stdout.write(`  ✓ ${code}\n`);
      } else {
        fail++;
        process.stdout.write(`  ✗ ${code} (HTTP ${status})\n`);
      }
    } catch (err) {
      fail++;
      process.stdout.write(`  ✗ ${code} (${err.message})\n`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`\nDone. ${ok} regenerated, ${fail} failed.`);
})();
