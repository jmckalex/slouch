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
    clicked_at TEXT DEFAULT (datetime('now'))
  );
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
  logClick: db.prepare('INSERT INTO click_log (code, type, ip, user_agent, referer) VALUES (?, ?, ?, ?, ?)'),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM links) as total_links,
      (SELECT SUM(clicks) FROM links) as total_clicks,
      (SELECT COUNT(*) FROM files) as total_files,
      (SELECT SUM(downloads) FROM files) as total_downloads
  `),
};

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

// Get stats
app.get('/api/stats', requireAuth, (req, res) => {
  res.json(stmts.stats.get());
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

// ─── Redirect / Serve Route ───
app.get('/:code', (req, res) => {
  const { code } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  
  // Check links first
  const link = stmts.getLink.get(code);
  if (link) {
    stmts.clickLink.run(code);
    stmts.logClick.run(code, 'link', ip, userAgent, referer);
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
    stmts.logClick.run(code, 'file', ip, userAgent, referer);
    
    res.set('Content-Type', file.mime_type);
    res.set('Content-Disposition', `inline; filename="${file.original_name}"`);
    return res.sendFile(filePath);
  }
  
  // Nothing found
  res.status(404).send('Not found');
});

// ─── Root ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`slou.ch running on port ${PORT}`);
});
