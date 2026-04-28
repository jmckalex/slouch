#!/usr/bin/env node
/**
 * og-debug.js — diagnose what's happening inside Puppeteer when rendering
 * the OG interstitial for /mathtest.
 *
 * Mirrors the renderCodeToPng() flow in server.js: navigates to the
 * internal /__og-html route via page.goto so relative URLs resolve, then
 * polls window.__ogReady and MathJax internals for 10s.
 *
 * Run on the droplet from /var/www/slouch:
 *   sudo -u ghostuser node og-debug.js
 *
 * Looks for three failure modes:
 *   1. MathJax bundle didn't load (check RESP lines for tex-svg.js status)
 *   2. MathJax loaded but never typeset (mjx-container count stays 0)
 *   3. JS error in readiness script (PAGE ERROR lines)
 */

const puppeteer = require('puppeteer');

const TARGET_URL = 'http://127.0.0.1:3001/mathtest/__og-html';
const POLL_INTERVAL_MS = 500;
const POLL_DURATION_MS = 10000;

(async () => {
  console.log('=== Launching Chromium ===');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE ' + msg.type().toUpperCase() + ':', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  page.on('requestfailed', req => {
    const failure = req.failure();
    console.log('REQ FAIL:', req.url(), '-', failure && failure.errorText);
  });
  page.on('response', res => {
    const url = res.url();
    if (url.includes('mathjax') || url.includes('vendor') || url.includes('cdnjs') ||
        url.includes('fontawesome') || url.includes('googleapis') ||
        url.includes('__og-html')) {
      console.log('RESP', res.status() + ':', url);
    }
  });

  console.log();
  console.log('=== Navigating to ' + TARGET_URL + ' ===');
  await page.setViewport({ width: 1200, height: 630 });
  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 12000 });
  console.log('goto complete');
  console.log();

  console.log('=== Polling state ===');
  const iterations = Math.ceil(POLL_DURATION_MS / POLL_INTERVAL_MS);
  for (let i = 0; i < iterations; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const state = await page.evaluate(() => {
      const mj = window.MathJax;
      return {
        ogReady: window.__ogReady,
        mathJax: !!mj,
        startup: !!(mj && mj.startup),
        startupPromise: !!(mj && mj.startup && mj.startup.promise),
        startupDocument: !!(mj && mj.startup && mj.startup.document),
        typesetCount: document.querySelectorAll('mjx-container').length,
        rawDollarSigns: (document.body.innerText.match(/\$[^$]+\$/g) || []).length,
      };
    });
    const t = ((i + 1) * POLL_INTERVAL_MS).toString().padStart(5);
    console.log(`t=${t}ms  ${JSON.stringify(state)}`);
    if (state.ogReady === true && state.typesetCount > 0) {
      console.log('(stopping early: ready and typeset)');
      break;
    }
  }
  console.log();

  console.log('=== Final body text excerpt ===');
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log(bodyText);
  console.log();

  await browser.close();
  console.log('Done.');
})().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
