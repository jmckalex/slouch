/**
 * slou.ch — Personal URL shortener & file host
 *
 * Routes:
 *   GET  /:code        → redirect to stored URL or serve file
 *   GET  /admin        → admin dashboard (password-protected)
 *   POST /api/shorten  → create short link
 *   POST /api/upload   → upload file
 *   GET  /api/links    → list all links (JSON)
 *   GET  /api/files    → list all files (JSON)
 *   DELETE /api/links/:code → delete a link
 *   DELETE /api/files/:code → delete a file
 *   GET  /api/stats           → simple aggregate counts (header strip)
 *   GET  /api/stats/summary   → human/bot split for today/week/month/all
 *   GET  /api/stats/top-links → most-clicked links with stats
 *   GET  /api/stats/top-files → most-downloaded files with stats
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

// ─── Configuration ───
const PORT = process.env.PORT || 3001;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme'; // Change this!
const BASE_URL = process.env.BASE_URL || 'https://slou.ch';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'slouch.db');
const CODE_LENGTH = 6;

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Database Setup ───
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Tables (CREATE IF NOT EXISTS — safe to run on existing DBs).
// Indexes that don't depend on the is_bot column live here too.
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    code TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
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

// Schema migration: add is_bot column to existing click_log if missing.
// Must happen BEFORE creating indexes that reference is_bot, otherwise
// the index creation fails on databases that pre-date this column.
try {
  const cols = db.prepare("PRAGMA table_info(click_log)").all();
  if (!cols.find(c => c.name === 'is_bot')) {
    db.exec('ALTER TABLE click_log ADD COLUMN is_bot INTEGER DEFAULT 0');
  }
} catch (err) {
  console.error('Schema migration warning:', err.message);
}

// Indexes that depend on the migration having run
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_click_log_is_bot ON click_log(is_bot);
`);

// Prepared statements
const stmts = {
  getLink: db.prepare('SELECT * FROM links WHERE code = ?'),
  getFile: db.prepare('SELECT * FROM files WHERE code = ?'),
  insertLink: db.prepare('INSERT INTO links (code, url, title) VALUES (?, ?, ?)'),
  insertFile: db.prepare('INSERT INTO files (code, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'),
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

  // Stats: summary buckets (human vs bot)
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

  // Top links: aggregate stats per code (links only)
  topLinks: db.prepare(`
    SELECT
      l.code,
      l.url,
      l.title,
      l.created_at,
      COUNT(c.id) as total_hits,
      SUM(CASE WHEN c.is_bot = 0 THEN 1 ELSE 0 END) as human_hits,
      SUM(CASE WHEN c.is_bot = 1 THEN 1 ELSE 0 END) as bot_hits,
      MAX(c.clicked_at) as last_hit
    FROM links l
    LEFT JOIN click_log c ON l.code = c.code AND c.type = 'link'
    GROUP BY l.code
    ORDER BY human_hits DESC, total_hits DESC
    LIMIT ?
  `),

  // Top files: aggregate stats per code (files only)
  topFiles: db.prepare(`
    SELECT
      f.code,
      f.original_name,
      f.size,
      f.mime_type,
      f.created_at,
      COUNT(c.id) as total_hits,
      SUM(CASE WHEN c.is_bot = 0 THEN 1 ELSE 0 END) as human_hits,
      SUM(CASE WHEN c.is_bot = 1 THEN 1 ELSE 0 END) as bot_hits,
      MAX(c.clicked_at) as last_hit
    FROM files f
    LEFT JOIN click_log c ON f.code = c.code AND c.type = 'file'
    GROUP BY f.code
    ORDER BY human_hits DESC, total_hits DESC
    LIMIT ?
  `),

  // Top referrer for a given code
  topReferer: db.prepare(`
    SELECT referer, COUNT(*) as cnt
    FROM click_log
    WHERE code = ? AND is_bot = 0 AND referer IS NOT NULL AND referer != ''
    GROUP BY referer
    ORDER BY cnt DESC
    LIMIT 1
  `),

  // Recent clicks for a given code (for the detail panel)
  detailClicks: db.prepare(`
    SELECT c.id, c.ip, c.user_agent, c.referer, c.is_bot, c.clicked_at,
           g.country, g.country_code, g.city, g.region
    FROM click_log c
    LEFT JOIN ip_geo g ON c.ip = g.ip
    WHERE c.code = ?
    ORDER BY c.clicked_at DESC
    LIMIT ?
  `),

  // Top country for a given code (humans only)
  topCountry: db.prepare(`
    SELECT g.country, g.country_code, COUNT(*) as cnt
    FROM click_log c
    JOIN ip_geo g ON c.ip = g.ip
    WHERE c.code = ? AND c.is_bot = 0 AND g.country IS NOT NULL
    GROUP BY g.country
    ORDER BY cnt DESC
    LIMIT 1
  `),

  // Geo cache
  getGeo: db.prepare('SELECT * FROM ip_geo WHERE ip = ?'),
  insertGeo: db.prepare(`INSERT OR REPLACE INTO ip_geo
    (ip, country, country_code, region, city) VALUES (?, ?, ?, ?, ?)`),

  // Distinct unresolved IPs in click_log (for lazy backfill)
  unresolvedIps: db.prepare(`
    SELECT DISTINCT c.ip
    FROM click_log c
    LEFT JOIN ip_geo g ON c.ip = g.ip
    WHERE g.ip IS NULL AND c.ip IS NOT NULL AND c.ip != ''
    LIMIT ?
  `),
};

// ─── Bot detection ───
const BOT_PATTERNS = /bot|crawler|spider|crawling|slurp|wget|curl|python-requests|node-fetch|axios|http\.rb|java\/|go-http-client|headless|phantomjs|lighthouse|preview|fetch|monitor|uptime|pingdom|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|skypeuripreview|google-pagespeed|chrome-lighthouse|gtmetrix|ahrefs|semrush|mj12bot|dotbot|petalbot|bytespider|duckduckbot|baiduspider|yandexbot/i;

function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_PATTERNS.test(userAgent);
}

// ─── Geolocation (with caching) ───
// Uses ipapi.co's free endpoint. Results cached forever in ip_geo table.
// Skips private/loopback IPs entirely.

function isPrivateIp(ip) {
  if (!ip) return true;
  // Strip IPv6 prefix if present (common for IPv4-mapped IPv6)
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(clean)) return true;
  if (/^fe80:/i.test(clean)) return true;  // IPv6 link-local
  if (/^fc00:/i.test(clean)) return true;  // IPv6 unique-local
  return false;
}

function normaliseIp(raw) {
  if (!raw) return '';
  // x-forwarded-for can be a comma-separated list; first entry is the original client
  const first = raw.split(',')[0].trim();
  return first.replace(/^::ffff:/, '');
}

async function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) {
    return null;
  }

  // Check cache first
  const cached = stmts.getGeo.get(ip);
  if (cached) return cached;

  // Hit ipapi.co. Free tier: 1000 requests/day, ~1/sec.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'slou.ch/1.0' }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Cache a "lookup failed" entry so we don't keep retrying
      stmts.insertGeo.run(ip, null, null, null, null);
      return null;
    }

    const data = await res.json();
    if (data.error) {
      stmts.insertGeo.run(ip, null, null, null, null);
      return null;
    }

    stmts.insertGeo.run(
      ip,
      data.country_name || null,
      data.country_code || null,
      data.region || null,
      data.city || null
    );

    return {
      ip,
      country: data.country_name || null,
      country_code: data.country_code || null,
      region: data.region || null,
      city: data.city || null
    };
  } catch (err) {
    // Network error, timeout, etc. — don't cache so we can retry later
    return null;
  }
}

// Backfill geolocation for unresolved IPs in click_log.
// Called before stats endpoints so the data is fresh when displayed.
// Limited per call to avoid hammering ipapi.co.
async function backfillGeo(maxLookups = 20) {
  const ips = stmts.unresolvedIps.all(maxLookups).map(r => r.ip);
  if (ips.length === 0) return 0;

  // Filter out private IPs (which lookupGeo skips anyway, but let's not even count them)
  const publicIps = ips.filter(ip => !isPrivateIp(ip));

  // For private IPs, insert a "no geo" entry so we don't try again
  for (const ip of ips.filter(isPrivateIp)) {
    stmts.insertGeo.run(ip, null, null, null, null);
  }

  // Look up public IPs in parallel (small N, so it's fine)
  await Promise.all(publicIps.map(ip => lookupGeo(ip)));

  return publicIps.length;
}

// ─── Express App ───
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static admin files
app.use('/admin', express.static(path.join(__dirname, 'public')));

// File upload config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// ─── Auth Middleware ───
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="slou.ch admin"');
    return res.status(401).send('Authentication required');
  }

  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64')
    .toString().split(':');

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="slou.ch admin"');
  res.status(401).send('Invalid credentials');
}

// ─── Helper ───
function generateCode(custom) {
  if (custom && custom.trim()) {
    const code = custom.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '');
    if (code.length === 0) throw new Error('Invalid custom code');
    if (code === 'admin' || code === 'api') throw new Error('Reserved code');
    if (stmts.getLink.get(code) || stmts.getFile.get(code)) {
      throw new Error('Code already in use');
    }
    return code;
  }

  // Generate random code, ensure uniqueness
  let code;
  do {
    code = nanoid(CODE_LENGTH);
  } while (stmts.getLink.get(code) || stmts.getFile.get(code));
  return code;
}

// ─── Admin Routes ───
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── API Routes ───

// Create short link
app.post('/api/shorten', requireAuth, (req, res) => {
  try {
    const { url, title, custom_code } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const code = generateCode(custom_code);
    stmts.insertLink.run(code, url, title || null);

    res.json({
      code,
      short_url: `${BASE_URL}/${code}`,
      url,
      title
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload file
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const code = generateCode(req.body.custom_code);
    const mimeType = req.file.mimetype || mime.lookup(req.file.originalname) || 'application/octet-stream';

    stmts.insertFile.run(
      code,
      req.file.originalname,
      req.file.filename,
      mimeType,
      req.file.size
    );

    res.json({
      code,
      short_url: `${BASE_URL}/${code}`,
      original_name: req.file.originalname,
      size: req.file.size,
      mime_type: mimeType
    });
  } catch (err) {
    // Clean up uploaded file on error
    if (req.file) {
      fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
    }
    res.status(400).json({ error: err.message });
  }
});

// List all links
app.get('/api/links', requireAuth, (req, res) => {
  res.json(stmts.allLinks.all());
});

// List all files
app.get('/api/files', requireAuth, (req, res) => {
  res.json(stmts.allFiles.all());
});

// Get simple stats (used by header strip)
app.get('/api/stats', requireAuth, (req, res) => {
  res.json(stmts.stats.get());
});

// ─── Stats endpoints ───

// Aggregate summary: humans vs bots, by time bucket
app.get('/api/stats/summary', requireAuth, (req, res) => {
  const summary = stmts.summary.get();
  // Replace nulls with 0 for cleaner JSON
  for (const k of Object.keys(summary)) {
    if (summary[k] === null) summary[k] = 0;
  }
  res.json(summary);
});

// Top links with rolled-up stats. Triggers geo backfill so countries are accurate.
app.get('/api/stats/top-links', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  await backfillGeo(20);

  const rows = stmts.topLinks.all(limit);
  // Decorate with top referer and top country per code
  for (const row of rows) {
    const ref = stmts.topReferer.get(row.code);
    row.top_referer = ref ? ref.referer : null;
    const country = stmts.topCountry.get(row.code);
    row.top_country = country ? country.country : null;
    row.top_country_code = country ? country.country_code : null;
  }
  res.json(rows);
});

// Top files
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

// Per-code detail: recent clicks with geo info
app.get('/api/stats/detail/:code', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  await backfillGeo(20);

  const rows = stmts.detailClicks.all(req.params.code, limit);
  res.json(rows);
});

// Delete link
app.delete('/api/links/:code', requireAuth, (req, res) => {
  const result = stmts.deleteLink.run(req.params.code);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// Delete file
app.delete('/api/files/:code', requireAuth, (req, res) => {
  const file = stmts.getFile.get(req.params.code);
  if (!file) return res.status(404).json({ error: 'Not found' });

  // Delete physical file
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  fs.unlink(filePath, () => {});

  stmts.deleteFile.run(req.params.code);
  res.json({ deleted: true });
});

// ─── Splash ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

// ─── Redirect / Serve Route ───
app.get('/:code', (req, res) => {
  const { code } = req.params;
  const ip = normaliseIp(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  const bot = isBot(userAgent) ? 1 : 0;

  // Check links first
  const link = stmts.getLink.get(code);
  if (link) {
    stmts.clickLink.run(code);
    stmts.logClick.run(code, 'link', ip, userAgent, referer, bot);
    return res.redirect(301, link.url);
  }

  // Check files
  const file = stmts.getFile.get(code);
  if (file) {
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    stmts.downloadFile.run(code);
    stmts.logClick.run(code, 'file', ip, userAgent, referer, bot);

    res.set('Content-Type', file.mime_type);
    res.set('Content-Disposition', `inline; filename="${file.original_name}"`);
    return res.sendFile(filePath);
  }

  // Nothing found
  res.status(404).send('Not found');
});

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`slou.ch running on port ${PORT}`);
});
