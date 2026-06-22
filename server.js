/**
 * slou.ch — Personal URL shortener & file host
 *
 * Routes:
 *   GET  /:code        → if note: interstitial page; otherwise: redirect/serve
 *   GET  /:code/go     → redirect/serve (skips interstitial)
 *   GET  /:code/og.png → social card image (Puppeteer-rendered, cached on disk)
 *   GET  /admin        → admin dashboard (password-protected)
 *   POST /api/shorten  → create short link
 *   POST /api/upload   → upload file
 *   GET  /api/links    → list all links (JSON)
 *   GET  /api/files    → list all files (JSON)
 *   PATCH /api/links/:code/note → update a link's note
 *   PATCH /api/files/:code/note → update a file's note
 *   DELETE /api/links/:code → delete a link
 *   DELETE /api/files/:code → delete a file
 *   GET  /api/stats           → simple aggregate counts
 *   GET  /api/stats/summary   → human/bot split
 *   GET  /api/stats/top-links → top links with stats
 *   GET  /api/stats/top-files → top files with stats
 *   GET  /api/stats/detail/:code → per-code recent clicks
 */

const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const { nanoid } = require('nanoid');
const mime = require('mime-types');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');
const puppeteer = require('puppeteer');

// ─── Configuration ───
const PORT = process.env.PORT || 3001;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const BASE_URL = process.env.BASE_URL || 'https://slou.ch';
const FONTAWESOME_CSS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OG_CACHE_DIR = path.join(__dirname, 'og-cache');
const DB_PATH = path.join(__dirname, 'slouch.db');
const CODE_LENGTH = 6;

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OG_CACHE_DIR)) fs.mkdirSync(OG_CACHE_DIR, { recursive: true });

// ─── Markdown setup ───
marked.setOptions({ breaks: true, gfm: true });

// ─── Math protection ───
function extractMath(md) {
  const placeholders = [];
  let counter = 0;
  const placeholder = () => `\x00MATHPH${counter++}\x00`;
  let out = md;

  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const ph = placeholder();
    placeholders.push({ ph, replacement: '$$' + math + '$$' });
    return ph;
  });
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    const ph = placeholder();
    placeholders.push({ ph, replacement: '\\[' + math + '\\]' });
    return ph;
  });
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    const ph = placeholder();
    placeholders.push({ ph, replacement: '\\(' + math + '\\)' });
    return ph;
  });
  out = out.replace(/\$([^\s\d$][^$\n]*?)\$/g, (_, math) => {
    const ph = placeholder();
    placeholders.push({ ph, replacement: '$' + math + '$' });
    return ph;
  });
  return { stripped: out, placeholders };
}

function restoreMath(html, placeholders) {
  let out = html;
  for (const { ph, replacement } of placeholders) {
    out = out.split(ph).join(replacement);
  }
  return out;
}

function renderMarkdown(md) {
  if (!md) return '';
  const { stripped, placeholders } = extractMath(md);
  const rawHtml = marked.parse(stripped);
  const withMath = restoreMath(rawHtml, placeholders);
  return DOMPurify.sanitize(withMath, {
    ALLOWED_TAGS: [
      'a', 'b', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'strong', 'ul', 'table', 'thead',
      'tbody', 'tr', 'th', 'td', 'del', 's', 'sup', 'sub', 'span'
    ],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'class'],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|xxx):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
}

function plainTextExcerpt(md, maxLen = 160) {
  if (!md) return '';
  const stripped = md
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .replace(/\$[^$\n]+\$/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_>~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen).trim() + '…';
}

function noteContainsMath(md) {
  if (!md) return false;
  return /\$\$[\s\S]+?\$\$/.test(md) ||
         /\$[^\s\d$][^$\n]*?\$/.test(md) ||
         /\\\[[\s\S]+?\\\]/.test(md) ||
         /\\\([\s\S]+?\\\)/.test(md);
}

function htmlEscape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Browser Manager ───
let _browser = null;
let _browserPromise = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_browserPromise) return _browserPromise;

  _browserPromise = (async () => {
    try {
      console.log('Launching Chromium for OG image generation…');
      const browser = await puppeteer.launch({
        headless: true,
        // Bound the CDP RPC timeout. If a single command (e.g. screenshot)
        // takes longer than this, Puppeteer rejects rather than waiting on
        // the default 30s. We pair this with an outer Promise.race in
        // renderHtmlToPng so a wedged browser can't hang the request path.
        protocolTimeout: 30000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--font-render-hinting=none'
        ]
      });
      browser.on('disconnected', () => {
        console.log('Chromium disconnected; will relaunch on next request');
        _browser = null;
      });
      _browser = browser;
      console.log('Chromium ready');
      return browser;
    } finally {
      _browserPromise = null;
    }
  })();

  return _browserPromise;
}

// Tear down the browser. Used when a render fails in a way that suggests
// the Chromium instance is wedged — e.g. screenshot protocol timeout. The
// next getBrowser() call will relaunch.
async function recycleBrowser(reason) {
  const b = _browser;
  _browser = null;
  if (b) {
    console.log('Recycling Chromium (' + reason + ')');
    try { await b.close(); } catch {}
  }
}

// Race a promise against a hard wall-clock deadline. On timeout, the returned
// promise rejects with an Error tagged so callers can branch on it.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'OG_RENDER_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Render the OG image for the given code. The page navigates to an internal
// route that returns the OG-mode HTML, which is the key reason we use goto
// rather than setContent: setContent gives the page a base URL of about:blank,
// which means relative-path script tags like /vendor/mathjax/es5/tex-svg.js
// can't be resolved and silently fail to load. Navigating to a real
// 127.0.0.1:PORT URL gives the page a proper origin, so /vendor/... resolves
// to http://127.0.0.1:PORT/vendor/... and Express serves it from the static
// mount.
async function renderCodeToPng(code, { hasMath } = {}) {
  const RENDER_BUDGET_MS = 20000;
  const internalUrl = `http://127.0.0.1:${PORT}/${encodeURIComponent(code)}/__og-html`;

  return withTimeout((async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let poisoned = false;
    try {
      await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1 });

      // 'load' fires on DOM + sync resources. We use the synchronous
      // (non-async) MathJax script tag so it's loaded before this resolves.
      await page.goto(internalUrl, { waitUntil: 'load', timeout: 12000 });

      // Wait for the readiness flag set by the page itself. The interstitial
      // template flips window.__ogReady to true after fonts have loaded and
      // (if applicable) MathJax has finished typesetting.
      await page.waitForFunction(() => window.__ogReady === true, { timeout: 12000 });

      // One more frame to let any final layout/paint settle.
      await new Promise(r => setTimeout(r, 100));

      // Puppeteer 22+ returns a Uint8Array from page.screenshot(), not a
      // Buffer. fs.writeFileSync handles both, but Express's res.send()
      // JSON-stringifies Uint8Array (producing `{"0":137,"1":80,...}`),
      // which silently corrupts the HTTP response while the disk cache
      // looks fine. Coerce here so callers get a real Node Buffer.
      const shot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT }
      });
      return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
    } catch (err) {
      poisoned = /captureScreenshot|protocolTimeout|Target closed|detached/i.test(err.message || '');
      throw err;
    } finally {
      try { await page.close(); } catch {}
      if (poisoned) {
        recycleBrowser('screenshot failure').catch(() => {});
      }
    }
  })(), RENDER_BUDGET_MS, 'OG render');
}

function ogCachePath(code) {
  const safe = code.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(OG_CACHE_DIR, `${safe}.png`);
}

function invalidateOgCache(code) {
  fs.unlink(ogCachePath(code), () => {});
}

// ─── Database Setup ───
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    code TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    note TEXT,
    clicks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_clicked TEXT
  );

  CREATE TABLE IF NOT EXISTS files (
    code TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER,
    note TEXT,
    downloads INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_downloaded TEXT
  );

  CREATE TABLE IF NOT EXISTS click_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    referer TEXT,
    is_bot INTEGER DEFAULT 0,
    clicked_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ip_geo (
    ip TEXT PRIMARY KEY,
    country TEXT,
    country_code TEXT,
    region TEXT,
    city TEXT,
    looked_up_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_click_log_code ON click_log(code);
  CREATE INDEX IF NOT EXISTS idx_click_log_clicked_at ON click_log(clicked_at);
`);

function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
try {
  ensureColumn('click_log', 'is_bot', 'INTEGER DEFAULT 0');
  ensureColumn('links', 'note', 'TEXT');
  ensureColumn('files', 'note', 'TEXT');
} catch (err) {
  console.error('Schema migration warning:', err.message);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_click_log_is_bot ON click_log(is_bot);`);

const stmts = {
  getLink: db.prepare('SELECT * FROM links WHERE code = ?'),
  getFile: db.prepare('SELECT * FROM files WHERE code = ?'),
  insertLink: db.prepare('INSERT INTO links (code, url, title, note) VALUES (?, ?, ?, ?)'),
  insertFile: db.prepare('INSERT INTO files (code, original_name, stored_name, mime_type, size, note) VALUES (?, ?, ?, ?, ?, ?)'),
  updateLinkNote: db.prepare('UPDATE links SET note = ? WHERE code = ?'),
  updateFileNote: db.prepare('UPDATE files SET note = ? WHERE code = ?'),
  clickLink: db.prepare('UPDATE links SET clicks = clicks + 1, last_clicked = datetime(\'now\') WHERE code = ?'),
  downloadFile: db.prepare('UPDATE files SET downloads = downloads + 1, last_downloaded = datetime(\'now\') WHERE code = ?'),
  allLinks: db.prepare('SELECT * FROM links ORDER BY created_at DESC'),
  allFiles: db.prepare('SELECT * FROM files ORDER BY created_at DESC'),
  deleteLink: db.prepare('DELETE FROM links WHERE code = ?'),
  deleteFile: db.prepare('DELETE FROM files WHERE code = ?'),
  logClick: db.prepare('INSERT INTO click_log (code, type, ip, user_agent, referer, is_bot) VALUES (?, ?, ?, ?, ?, ?)'),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM links) as total_links,
      (SELECT SUM(clicks) FROM links) as total_clicks,
      (SELECT COUNT(*) FROM files) as total_files,
      (SELECT SUM(downloads) FROM files) as total_downloads
  `),
  summary: db.prepare(`
    SELECT
      SUM(CASE WHEN c.is_bot = 0 AND c.clicked_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as humans_24h,
      SUM(CASE WHEN c.is_bot = 1 AND c.clicked_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as bots_24h,
      SUM(CASE WHEN c.is_bot = 0 AND c.clicked_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as humans_7d,
      SUM(CASE WHEN c.is_bot = 1 AND c.clicked_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as bots_7d,
      SUM(CASE WHEN c.is_bot = 0 AND c.clicked_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as humans_30d,
      SUM(CASE WHEN c.is_bot = 1 AND c.clicked_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as bots_30d,
      SUM(CASE WHEN c.is_bot = 0 THEN 1 ELSE 0 END) as humans_all,
      SUM(CASE WHEN c.is_bot = 1 THEN 1 ELSE 0 END) as bots_all,
      SUM(CASE WHEN l.code IS NULL AND f.code IS NULL AND c.clicked_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as orphaned_24h,
      SUM(CASE WHEN l.code IS NULL AND f.code IS NULL AND c.clicked_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as orphaned_7d,
      SUM(CASE WHEN l.code IS NULL AND f.code IS NULL AND c.clicked_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as orphaned_30d,
      SUM(CASE WHEN l.code IS NULL AND f.code IS NULL THEN 1 ELSE 0 END) as orphaned_all
    FROM click_log c
    LEFT JOIN links l ON c.code = l.code
    LEFT JOIN files f ON c.code = f.code
  `),
  topLinks: db.prepare(`
    SELECT l.code, l.url, l.title, l.note, l.created_at,
      COUNT(c.id) as total_hits,
      SUM(CASE WHEN c.is_bot = 0 THEN 1 ELSE 0 END) as human_hits,
      SUM(CASE WHEN c.is_bot = 1 THEN 1 ELSE 0 END) as bot_hits,
      MAX(c.clicked_at) as last_hit
    FROM links l LEFT JOIN click_log c ON l.code = c.code AND c.type = 'link'
    GROUP BY l.code ORDER BY human_hits DESC, total_hits DESC LIMIT ?
  `),
  topFiles: db.prepare(`
    SELECT f.code, f.original_name, f.size, f.mime_type, f.note, f.created_at,
      COUNT(c.id) as total_hits,
      SUM(CASE WHEN c.is_bot = 0 THEN 1 ELSE 0 END) as human_hits,
      SUM(CASE WHEN c.is_bot = 1 THEN 1 ELSE 0 END) as bot_hits,
      MAX(c.clicked_at) as last_hit
    FROM files f LEFT JOIN click_log c ON f.code = c.code AND c.type = 'file'
    GROUP BY f.code ORDER BY human_hits DESC, total_hits DESC LIMIT ?
  `),
  topReferer: db.prepare(`
    SELECT referer, COUNT(*) as cnt FROM click_log
    WHERE code = ? AND is_bot = 0 AND referer IS NOT NULL AND referer != ''
    GROUP BY referer ORDER BY cnt DESC LIMIT 1
  `),
  detailClicks: db.prepare(`
    SELECT c.id, c.ip, c.user_agent, c.referer, c.is_bot, c.clicked_at,
           g.country, g.country_code, g.city, g.region
    FROM click_log c LEFT JOIN ip_geo g ON c.ip = g.ip
    WHERE c.code = ? ORDER BY c.clicked_at DESC LIMIT ?
  `),
  topCountry: db.prepare(`
    SELECT g.country, g.country_code, COUNT(*) as cnt
    FROM click_log c JOIN ip_geo g ON c.ip = g.ip
    WHERE c.code = ? AND c.is_bot = 0 AND g.country IS NOT NULL
    GROUP BY g.country ORDER BY cnt DESC LIMIT 1
  `),
  getGeo: db.prepare('SELECT * FROM ip_geo WHERE ip = ?'),
  insertGeo: db.prepare('INSERT OR REPLACE INTO ip_geo (ip, country, country_code, region, city) VALUES (?, ?, ?, ?, ?)'),
  unresolvedIps: db.prepare(`
    SELECT DISTINCT c.ip FROM click_log c LEFT JOIN ip_geo g ON c.ip = g.ip
    WHERE g.ip IS NULL AND c.ip IS NOT NULL AND c.ip != '' LIMIT ?
  `),
};

// ─── Bot detection ───
const BOT_PATTERNS = /bot|crawler|spider|crawling|slurp|wget|curl|python-requests|node-fetch|axios|http\.rb|java\/|go-http-client|headless|phantomjs|lighthouse|preview|fetch|monitor|uptime|pingdom|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|skypeuripreview|google-pagespeed|chrome-lighthouse|gtmetrix|ahrefs|semrush|mj12bot|dotbot|petalbot|bytespider|duckduckbot|baiduspider|yandexbot/i;

function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_PATTERNS.test(userAgent);
}

// ─── Geolocation ───
function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(clean)) return true;
  if (/^fe80:/i.test(clean)) return true;
  if (/^fc00:/i.test(clean)) return true;
  return false;
}

function normaliseIp(raw) {
  if (!raw) return '';
  return raw.split(',')[0].trim().replace(/^::ffff:/, '');
}

async function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) return null;
  const cached = stmts.getGeo.get(ip);
  if (cached) return cached;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'slou.ch/1.0' }
    });
    clearTimeout(timeout);
    if (!res.ok) { stmts.insertGeo.run(ip, null, null, null, null); return null; }
    const data = await res.json();
    if (data.error) { stmts.insertGeo.run(ip, null, null, null, null); return null; }
    stmts.insertGeo.run(ip, data.country_name || null, data.country_code || null, data.region || null, data.city || null);
    return { ip, country: data.country_name || null, country_code: data.country_code || null, region: data.region || null, city: data.city || null };
  } catch { return null; }
}

async function backfillGeo(maxLookups = 20) {
  const ips = stmts.unresolvedIps.all(maxLookups).map(r => r.ip);
  if (ips.length === 0) return 0;
  const publicIps = ips.filter(ip => !isPrivateIp(ip));
  for (const ip of ips.filter(isPrivateIp)) stmts.insertGeo.run(ip, null, null, null, null);
  await Promise.all(publicIps.map(ip => lookupGeo(ip)));
  return publicIps.length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ─── OG image: build, render, and pre-generate ───

// Build the OG-mode interstitial HTML for a given code. Returns null if the
// code doesn't exist in either table.
function buildOgHtml(code) {
  const link = stmts.getLink.get(code);
  const file = stmts.getFile.get(code);
  if (!link && !file) return null;

  const kind = link ? 'link' : 'file';
  const target = link ? link.url : file.original_name;
  const title = link ? (link.title || null) : file.original_name;
  const noteRaw = link ? link.note : file.note;
  const fileSize = file ? formatBytes(file.size) : undefined;

  const effectiveNoteRaw = noteRaw && noteRaw.trim()
    ? noteRaw
    : (kind === 'file'
        ? `📎 **${file.original_name}**\n\nA file shared via slou.ch.`
        : `→ **${(() => { try { return new URL(link.url).hostname; } catch { return 'a link'; } })()}**\n\nA link shared via slou.ch.`);

  const noteHtml = renderMarkdown(effectiveNoteRaw);
  const noteExcerpt = plainTextExcerpt(effectiveNoteRaw);

  return {
    html: renderInterstitial({
      code, kind, target, title,
      noteHtml, noteExcerpt, noteRaw: effectiveNoteRaw,
      fileSize,
      ogMode: true
    }),
    hasMath: noteContainsMath(effectiveNoteRaw)
  };
}

// Render the OG image for a code and write to cache. Returns the PNG buffer
// (or null if the code doesn't exist).
async function generateOgImage(code) {
  // Verify the code exists before asking Puppeteer to navigate to its URL —
  // saves a wasted browser round-trip if the code is bogus.
  const built = buildOgHtml(code);
  if (!built) return null;
  const png = await renderCodeToPng(code, { hasMath: built.hasMath });
  fs.writeFileSync(ogCachePath(code), png);
  return png;
}

// Pre-generate the OG image asynchronously, primarily so social platforms
// fetching it find a cached copy ready. Errors are logged but not propagated.
function pregenerateOgImage(code) {
  // Defer with setImmediate so we don't block the API response that triggered this.
  setImmediate(async () => {
    try {
      // Invalidate any existing cache first, since the underlying note may have changed
      invalidateOgCache(code);
      await generateOgImage(code);
    } catch (err) {
      console.error('OG pre-generation failed for', code, err.message);
    }
  });
}

// ─── Express App ───
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));
// Public vendor assets (e.g. MathJax bundle used by interstitial + OG renderer).
// Mounted at /vendor so paths in the interstitial template are stable across
// admin/public/og-mode surfaces.
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), {
  maxAge: '7d',
  immutable: false
}));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({ storage });

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="slou.ch admin"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="slou.ch admin"');
  res.status(401).send('Invalid credentials');
}

function generateCode(custom) {
  if (custom && custom.trim()) {
    const code = custom.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '');
    if (code.length === 0) throw new Error('Invalid custom code');
    if (code === 'admin' || code === 'api') throw new Error('Reserved code');
    if (stmts.getLink.get(code) || stmts.getFile.get(code)) throw new Error('Code already in use');
    return code;
  }
  let code;
  do { code = nanoid(CODE_LENGTH); }
  while (stmts.getLink.get(code) || stmts.getFile.get(code));
  return code;
}

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create short link — also pre-generates the OG image
app.post('/api/shorten', requireAuth, (req, res) => {
  try {
    const { url, title, custom_code, note } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const code = generateCode(custom_code);
    stmts.insertLink.run(code, url, title || null, note || null);
    pregenerateOgImage(code);
    res.json({ code, short_url: `${BASE_URL}/${code}`, url, title, note });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload file — also pre-generates the OG image
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const code = generateCode(req.body.custom_code);
    const mimeType = req.file.mimetype || mime.lookup(req.file.originalname) || 'application/octet-stream';
    stmts.insertFile.run(code, req.file.originalname, req.file.filename, mimeType, req.file.size, req.body.note || null);
    pregenerateOgImage(code);
    res.json({
      code, short_url: `${BASE_URL}/${code}`,
      original_name: req.file.originalname, size: req.file.size, mime_type: mimeType,
      note: req.body.note || null
    });
  } catch (err) {
    if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
    res.status(400).json({ error: err.message });
  }
});

// Update link note — also re-generates the OG image
app.patch('/api/links/:code/note', requireAuth, (req, res) => {
  const link = stmts.getLink.get(req.params.code);
  if (!link) return res.status(404).json({ error: 'Not found' });
  const note = (req.body.note || '').trim() || null;
  stmts.updateLinkNote.run(note, req.params.code);
  pregenerateOgImage(req.params.code);
  res.json({ code: req.params.code, note });
});

// Update file note — also re-generates the OG image
app.patch('/api/files/:code/note', requireAuth, (req, res) => {
  const file = stmts.getFile.get(req.params.code);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const note = (req.body.note || '').trim() || null;
  stmts.updateFileNote.run(note, req.params.code);
  pregenerateOgImage(req.params.code);
  res.json({ code: req.params.code, note });
});

app.get('/api/links', requireAuth, (req, res) => res.json(stmts.allLinks.all()));
app.get('/api/files', requireAuth, (req, res) => res.json(stmts.allFiles.all()));
app.get('/api/stats', requireAuth, (req, res) => res.json(stmts.stats.get()));

app.get('/api/stats/summary', requireAuth, (req, res) => {
  const summary = stmts.summary.get();
  for (const k of Object.keys(summary)) if (summary[k] === null) summary[k] = 0;
  res.json(summary);
});

app.get('/api/stats/top-links', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  await backfillGeo(20);
  const rows = stmts.topLinks.all(limit);
  for (const row of rows) {
    const ref = stmts.topReferer.get(row.code);
    row.top_referer = ref ? ref.referer : null;
    const country = stmts.topCountry.get(row.code);
    row.top_country = country ? country.country : null;
    row.top_country_code = country ? country.country_code : null;
  }
  res.json(rows);
});

app.get('/api/stats/top-files', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  await backfillGeo(20);
  const rows = stmts.topFiles.all(limit);
  for (const row of rows) {
    const ref = stmts.topReferer.get(row.code);
    row.top_referer = ref ? ref.referer : null;
    const country = stmts.topCountry.get(row.code);
    row.top_country = country ? country.country : null;
    row.top_country_code = country ? country.country_code : null;
  }
  res.json(rows);
});

app.get('/api/stats/detail/:code', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  await backfillGeo(20);
  res.json(stmts.detailClicks.all(req.params.code, limit));
});

app.delete('/api/links/:code', requireAuth, (req, res) => {
  const result = stmts.deleteLink.run(req.params.code);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  invalidateOgCache(req.params.code);
  res.json({ deleted: true });
});

app.delete('/api/files/:code', requireAuth, (req, res) => {
  const file = stmts.getFile.get(req.params.code);
  if (!file) return res.status(404).json({ error: 'Not found' });
  fs.unlink(path.join(UPLOAD_DIR, file.stored_name), () => {});
  stmts.deleteFile.run(req.params.code);
  invalidateOgCache(req.params.code);
  res.json({ deleted: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

// ─── Interstitial template ───
function renderInterstitial({ code, kind, target, title, noteHtml, noteExcerpt, noteRaw, fileSize, ogMode = false }) {
  const pageTitle = title || (kind === 'file' ? `slou.ch — ${target}` : `slou.ch / ${code}`);
  const ogDescription = noteExcerpt || (kind === 'file'
    ? `A file shared via slou.ch`
    : `A link shared via slou.ch`);
  const ogImageUrl = `${BASE_URL}/${encodeURIComponent(code)}/og.png`;
  const buttonLabel = kind === 'file' ? 'Download file' : 'Continue to link';
  const buttonIcon = kind === 'file'
    ? '<i class="fa-solid fa-download"></i>'
    : '<i class="fa-solid fa-arrow-right"></i>';
  const targetDisplay = kind === 'file' ? target : new URL(target).hostname;
  const goUrl = `/${encodeURIComponent(code)}/go`;
  const needsMath = noteContainsMath(noteRaw);

  // ── OG-readiness signal ──
  // Puppeteer waits for window.__ogReady === true before screenshotting.
  // The MathJax script is loaded *synchronously* (no async attribute) for
  // two reasons:
  //   1. Async + setContent('load') in Puppeteer drops the script — the
  //      load event fires before async fetches even start, so MathJax
  //      never loads at all in the OG renderer. Dropping async makes the
  //      browser actually fetch and run it before the load event.
  //   2. For the user-facing interstitial, the few-hundred-ms cost is
  //      invisible because MathJax has to finish before the page is
  //      useful anyway.
  // Once the script finishes executing, MathJax.startup.promise exists and
  // resolves after initial typesetting completes.
  const readinessScript = needsMath ? `
<script>
  window.__ogReady = false;
  window.MathJax = {
    tex: {
      inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
      displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
      processEscapes: true
    },
    options: {
      skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      ignoreHtmlClass: 'no-mathjax',
      enableMenu: false
    },
    svg: { fontCache: 'global' }
  };
</script>
<script src="/vendor/mathjax/es5/tex-svg.js" id="MathJax-script"></script>
<script>
  // By the time this runs, MathJax.startup is populated.
  // startup.promise resolves after the initial typesetting pass.
  if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
    window.MathJax.startup.promise
      .then(function () {
        return (document.fonts && document.fonts.ready) || Promise.resolve();
      })
      .then(function () { window.__ogReady = true; })
      .catch(function (err) {
        // Even on a typeset error, signal readiness so we capture
        // *something* rather than time out — the image will show raw TeX.
        console.error('MathJax readiness error:', err && err.message);
        window.__ogReady = true;
      });
  } else {
    // MathJax script failed entirely — don't hang.
    console.error('MathJax did not load; flipping __ogReady to capture raw output');
    window.__ogReady = true;
  }
</script>
` : `
<script>
  window.__ogReady = false;
  (function () {
    var done = function () { window.__ogReady = true; };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(done, done);
    } else {
      // Fallback: never block forever.
      setTimeout(done, 500);
    }
  })();
</script>
`;

  const bodyClass = ogMode ? 'og-mode' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlEscape(pageTitle)}</title>
<meta name="description" content="${htmlEscape(ogDescription)}">
<meta property="og:title" content="${htmlEscape(pageTitle)}">
<meta property="og:description" content="${htmlEscape(ogDescription)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${htmlEscape(BASE_URL + '/' + code)}">
<meta property="og:site_name" content="slou.ch">
<meta property="og:image" content="${htmlEscape(ogImageUrl)}">
<meta property="og:image:width" content="${OG_WIDTH}">
<meta property="og:image:height" content="${OG_HEIGHT}">
<meta property="og:image:alt" content="${htmlEscape(pageTitle)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${htmlEscape(ogImageUrl)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
${ogMode ? '' : `<link rel="stylesheet" href="${FONTAWESOME_CSS_URL}" crossorigin="anonymous" referrerpolicy="no-referrer">`}
${readinessScript}
<style>
  :root {
    --ink: #2c2c2c; --ink-mid: #444; --ink-light: #888; --ink-faint: #b8b3a8;
    --paper: #faf8f3; --paper-warm: #f3efe5; --paper-shadow: #e8e3d4;
    --accent: #8b7355; --accent-hover: #6d5a43;
    --gold: #b8a060; --burgundy: #8b4a4a;
    --font-serif: 'Crimson Pro', Georgia, serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    min-height: 100vh; background: var(--paper); color: var(--ink);
    font-family: var(--font-serif); font-size: 18px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  body {
    background:
      radial-gradient(ellipse at 20% 10%, rgba(184, 160, 96, 0.05), transparent 50%),
      radial-gradient(ellipse at 80% 80%, rgba(139, 115, 85, 0.06), transparent 50%),
      var(--paper);
  }
  .page { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; padding: 36px clamp(24px, 6vw, 80px); max-width: 760px; margin: 0 auto; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ink-light); }
  .topbar a { color: var(--ink-light); text-decoration: none; }
  .topbar a:hover { color: var(--accent); }
  .topbar .right { color: var(--ink-faint); }
  main { display: flex; flex-direction: column; justify-content: center; padding: 40px 0; animation: fadein 0.5s ease-out; }
  @keyframes fadein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .wordmark { font-family: var(--font-serif); font-weight: 500; font-size: clamp(48px, 7vw, 80px); line-height: 0.9; letter-spacing: -0.03em; color: var(--ink); margin-bottom: 32px; user-select: none; }
  .wordmark .l { display: inline-block; }
  .wordmark .l1 { transform: translateY(0); }
  .wordmark .l2 { transform: translateY(1px) skew(-2deg); }
  .wordmark .l3 { transform: translateY(2px); }
  .wordmark .l4 { transform: translateY(3px) skew(-3deg); font-style: italic; }
  .wordmark .dot { color: var(--accent); transform: translateY(4px); display: inline-block; }
  .wordmark .l5 { transform: translateY(5px) skew(-4deg); }
  .wordmark .l6 { transform: translateY(6px) skew(-5deg); color: var(--accent); }
  .wordmark .codepart { color: var(--ink-faint); font-family: var(--font-mono); font-size: 0.45em; font-weight: 400; margin-left: 16px; letter-spacing: 0; }
  .wordmark .codepart .slash { color: var(--ink-faint); margin: 0 4px; }
  .wordmark .codepart .code { color: var(--accent); }

  .note { font-family: var(--font-serif); color: var(--ink-mid); font-size: clamp(17px, 1.3vw, 19px); line-height: 1.7; margin-bottom: 40px; padding-left: clamp(8px, 3vw, 32px); border-left: 2px solid var(--paper-shadow); max-width: 640px; }
  .note > *:first-child { margin-top: 0; }
  .note > *:last-child { margin-bottom: 0; }
  .note h1, .note h2, .note h3, .note h4 { font-weight: 600; margin: 1em 0 0.5em; letter-spacing: -0.01em; color: var(--ink); }
  .note h1 { font-size: 1.5em; } .note h2 { font-size: 1.3em; } .note h3 { font-size: 1.15em; }
  .note p { margin: 0.8em 0; }
  .note a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--paper-shadow); transition: border-color 0.15s ease; }
  .note a:hover { border-bottom-color: var(--accent); }
  .note ul, .note ol { margin: 0.8em 0 0.8em 1.5em; }
  .note li { margin: 0.3em 0; }
  .note blockquote { margin: 1em 0; padding-left: 1em; border-left: 2px solid var(--accent); font-style: italic; color: var(--ink-light); }
  .note code { font-family: var(--font-mono); font-size: 0.88em; background: var(--paper-warm); padding: 1px 6px; border-radius: 3px; color: var(--accent); }
  .note pre { font-family: var(--font-mono); background: var(--paper-warm); border: 1px solid var(--paper-shadow); border-radius: 4px; padding: 14px 18px; overflow-x: auto; margin: 1em 0; font-size: 0.85em; line-height: 1.55; }
  .note pre code { background: none; padding: 0; color: var(--ink); }
  .note hr { margin: 1.5em 0; border: 0; border-top: 1px dashed var(--paper-shadow); }
  .note img { max-width: 100%; border-radius: 4px; }
  .note table { border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
  .note th, .note td { border: 1px solid var(--paper-shadow); padding: 6px 12px; text-align: left; }
  .note th { background: var(--paper-warm); }
  .note mjx-container { color: var(--ink); }
  .note mjx-container[display="true"] { margin: 0.8em 0; }

  .actions { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding-left: clamp(8px, 3vw, 32px); }
  .btn-primary { display: inline-flex; align-items: center; gap: 12px; padding: 14px 26px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; text-decoration: none; background: var(--ink); color: var(--paper); border-radius: 4px; transition: all 180ms ease; }
  .btn-primary:hover { background: var(--accent); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(139, 115, 85, 0.25); }
  .btn-primary i { font-size: 13px; transition: transform 180ms ease; }
  .btn-primary:hover i.fa-arrow-right { transform: translateX(3px); }
  .btn-primary:hover i.fa-download { transform: translateY(2px); }

  .target-display { font-family: var(--font-mono); font-size: 12px; color: var(--ink-light); letter-spacing: 0.04em; }
  .target-display .key { color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; margin-right: 6px; }
  .target-display .file-size { color: var(--ink-faint); margin-left: 6px; }

  .footer { display: flex; justify-content: space-between; align-items: baseline; margin-top: 64px; padding-top: 24px; border-top: 1px dashed var(--paper-shadow); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-faint); }
  .footer a { color: var(--ink-light); text-decoration: none; }
  .footer a:hover { color: var(--accent); }

  @media (max-width: 600px) {
    .page { padding: 24px 20px; }
    .actions { padding-left: 0; flex-direction: column; align-items: flex-start; gap: 10px; }
    .note { padding-left: 16px; }
    .footer { flex-direction: column; gap: 8px; align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }

  body.og-mode {
    width: ${OG_WIDTH}px;
    height: ${OG_HEIGHT}px;
    overflow: hidden;
    min-height: 0;
    margin: 0;
  }
  body.og-mode .page {
    min-height: ${OG_HEIGHT}px;
    height: ${OG_HEIGHT}px;
    max-width: none;
    width: ${OG_WIDTH}px;
    padding: 50px 80px;
    display: block;
    margin: 0;
    overflow: hidden;
  }
  body.og-mode .topbar { display: none; }
  body.og-mode .actions { display: none; }
  body.og-mode .footer { display: none; }
  body.og-mode main { padding: 0; animation: none; }
  body.og-mode .wordmark { font-size: 96px; margin-bottom: 28px; }
  body.og-mode .wordmark .codepart { font-size: 0.4em; }
  body.og-mode .note { margin-bottom: 0; max-width: 1040px; font-size: 22px; line-height: 1.55; }
  body.og-mode .note p { margin: 0.5em 0; }
  body.og-mode .note h1 { font-size: 1.4em; margin: 0.4em 0 0.3em; }
  body.og-mode .note h2 { font-size: 1.25em; margin: 0.4em 0 0.3em; }
  body.og-mode .note h3 { font-size: 1.1em; margin: 0.4em 0 0.3em; }
</style>
</head>
<body class="${bodyClass}">
<div class="page">
  <header class="topbar">
    <a href="/">slou.ch</a>
    <span class="right">a note</span>
  </header>

  <main>
    <h1 class="wordmark">
      <span class="l l1">s</span><span class="l l2">l</span><span class="l l3">o</span><span class="l l4">u</span><span class="dot">.</span><span class="l l5">c</span><span class="l l6">h</span><span class="codepart"><span class="slash">/</span><span class="code">${htmlEscape(code)}</span></span>
    </h1>

    <div class="note">
      ${noteHtml}
    </div>

    <div class="actions">
      <a class="btn-primary" href="${htmlEscape(goUrl)}">
        ${buttonIcon} ${htmlEscape(buttonLabel)}
      </a>
      <span class="target-display">
        <span class="key">${kind === 'file' ? 'File:' : 'Goes to:'}</span>${htmlEscape(targetDisplay)}${fileSize ? `<span class="file-size">· ${htmlEscape(fileSize)}</span>` : ''}
      </span>
    </div>
  </main>

  <footer class="footer">
    <span>slou.ch · a personal endpoint</span>
    <span><a href="https://jmckalex.org">jmckalex.org</a></span>
  </footer>
</div>
</body>
</html>`;
}

// ─── OG image route ───
app.get('/:code/og.png', async (req, res) => {
  const { code } = req.params;
  const cacheFile = ogCachePath(code);

  if (fs.existsSync(cacheFile)) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cacheFile);
  }

  // Cache miss: generate now (lazy fallback when pre-generation didn't run or failed)
  const link = stmts.getLink.get(code);
  const file = stmts.getFile.get(code);
  if (!link && !file) return res.status(404).send('Not found');

  try {
    const png = await generateOgImage(code);
    if (!png) return res.status(404).send('Not found');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(png);
  } catch (err) {
    const isTimeout = err && err.code === 'OG_RENDER_TIMEOUT';
    console.error(
      'OG image generation failed for', code,
      isTimeout ? '(timeout)' : '-', err.message
    );
    // 503 + Retry-After is correct for "try again soon": social-card
    // unfurlers (Slack, Mail, Discord, etc.) will retry on 503 but treat
    // 500 as permanent. Browser of curious humans gets a friendly message.
    res.set('Retry-After', '5');
    return res.status(503).send('Image generation in progress, please retry');
  }
});

// Internal route: returns the OG-mode HTML for a code so Puppeteer can
// page.goto() it. Bound to 127.0.0.1 only — refuses any non-loopback
// request as a defence-in-depth measure (also nginx doesn't proxy this
// path, so external clients can't reach it through the public hostname
// anyway, but belt-and-braces costs nothing).
app.get('/:code/__og-html', (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return res.status(404).send('Not found');
  }
  const built = buildOgHtml(req.params.code);
  if (!built) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  return res.send(built.html);
});

// ─── /:code/go and /:code routes ───
app.get('/:code/go', (req, res) => {
  const { code } = req.params;
  const ip = normaliseIp(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  const bot = isBot(userAgent) ? 1 : 0;

  const link = stmts.getLink.get(code);
  if (link) {
    stmts.clickLink.run(code);
    stmts.logClick.run(code, 'link', ip, userAgent, referer, bot);
    return res.redirect(301, link.url);
  }

  const file = stmts.getFile.get(code);
  if (file) {
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    stmts.downloadFile.run(code);
    stmts.logClick.run(code, 'file', ip, userAgent, referer, bot);
    res.set('Content-Type', file.mime_type);
    res.set('Content-Disposition', `inline; filename="${file.original_name}"`);
    return res.sendFile(filePath);
  }

  res.status(404).send('Not found');
});

app.get('/:code', (req, res) => {
  const { code } = req.params;
  const ip = normaliseIp(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  const bot = isBot(userAgent) ? 1 : 0;

  const link = stmts.getLink.get(code);
  if (link) {
    if (link.note && link.note.trim()) {
      stmts.clickLink.run(code);
      stmts.logClick.run(code, 'link', ip, userAgent, referer, bot);
      return res.send(renderInterstitial({
        code, kind: 'link', target: link.url,
        title: link.title || null,
        noteHtml: renderMarkdown(link.note),
        noteExcerpt: plainTextExcerpt(link.note),
        noteRaw: link.note
      }));
    }
    stmts.clickLink.run(code);
    stmts.logClick.run(code, 'link', ip, userAgent, referer, bot);
    return res.redirect(301, link.url);
  }

  const file = stmts.getFile.get(code);
  if (file) {
    if (file.note && file.note.trim()) {
      stmts.downloadFile.run(code);
      stmts.logClick.run(code, 'file', ip, userAgent, referer, bot);
      return res.send(renderInterstitial({
        code, kind: 'file', target: file.original_name,
        title: file.original_name,
        noteHtml: renderMarkdown(file.note),
        noteExcerpt: plainTextExcerpt(file.note),
        noteRaw: file.note,
        fileSize: formatBytes(file.size)
      }));
    }
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    stmts.downloadFile.run(code);
    stmts.logClick.run(code, 'file', ip, userAgent, referer, bot);
    res.set('Content-Type', file.mime_type);
    res.set('Content-Disposition', `inline; filename="${file.original_name}"`);
    return res.sendFile(filePath);
  }

  res.status(404).send('Not found');
});

process.on('SIGTERM', async () => {
  if (_browser) {
    try { await _browser.close(); } catch {}
  }
  process.exit(0);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`slou.ch running on port ${PORT}`);
  getBrowser().catch(err => console.error('Failed to pre-warm browser:', err.message));
});
