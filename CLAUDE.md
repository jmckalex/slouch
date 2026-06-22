# CLAUDE.md

Guidance for working in this repository.

## What this is

**slou.ch** — a personal URL shortener and file host, served at `https://slou.ch`
from a DigitalOcean droplet. Single-author, single-admin. A short code
(`slou.ch/CODE`) either redirects to a URL or serves an uploaded file. Codes can
carry a Markdown/LaTeX **note**, in which case visiting the code shows an
**interstitial page** (with a social-card OG image) instead of redirecting
immediately.

Everything server-side lives in one file: **`server.js`** (~1100 lines). There is
no build step and no framework beyond Express. Keep it that way unless there's a
strong reason not to.

## Stack

- **Node + Express** — single process, listens on `127.0.0.1:PORT` (default 3001).
- **better-sqlite3** — synchronous SQLite (`slouch.db`, WAL mode). All queries are
  prepared once into the `stmts` object near the top of `server.js`.
- **multer** — file uploads to `uploads/`, stored under a random hex name, no size limit.
- **nanoid** — random 6-char codes (`CODE_LENGTH`).
- **marked + isomorphic-dompurify** — note rendering (Markdown → sanitized HTML).
- **puppeteer (headless Chromium)** — renders the interstitial into a 1200×630 PNG
  social card, cached on disk in `og-cache/`.
- **Frontend** — static HTML in `public/`, no framework:
  - `public/splash.html` — public landing page at `/`.
  - `public/index.html` — admin dashboard at `/admin` (~1000 lines, self-contained).

Note: uploads are unbounded — both multer and nginx (`client_max_body_size 0`)
have their size limits disabled. Uploads are admin-only, so the practical bound
is the droplet's disk.
  - `public/vendor/mathjax/` — vendored MathJax, served at `/vendor/...`.

## Commands

```bash
npm start            # node server.js
npm run dev          # node --watch server.js (auto-restart on edit)
./deploy.sh          # rsync to droplet + chown + restart systemd service
```

Config is via environment variables (see `slouch.service.example`):
`PORT`, `BASE_URL`, `ADMIN_USER`, `ADMIN_PASS`. Defaults exist but `ADMIN_PASS`
defaults to `changeme` — production sets it in the systemd unit.

There is **no test suite** and **no linter** configured. `tools/` holds two
standalone diagnostic scripts, meant to be run *on the droplet* against the live
service:
- `tools/regen-og.js` — clears and regenerates every OG image by hitting the
  running server's `/:code/og.png` (reuses the one browser instance).
- `tools/og-debug.js` — verbose Puppeteer trace for diagnosing why a note's OG
  render stalls (MathJax load/typeset failures).

## Deployment

Production runs at `/var/www/slouch` on the droplet (IP `144.126.236.254`,
SSH alias `trocp`, service user `ghostuser`), managed by systemd as `slouch`,
behind an nginx reverse proxy terminating HTTPS (Let's Encrypt / certbot).

- `./deploy.sh` rsyncs the working tree (excluding db/uploads/og-cache/node_modules),
  fixes ownership, and `systemctl restart slouch`.
- `SETUP.md` — one-time server provisioning (systemd, nginx, certbot, DNS).
- `nginx-slouch.conf`, `slouch.service.example` — the deployed configs (the real
  `slouch.service` is gitignored because it contains the admin password).
- Upload size is uncapped: nginx uses `client_max_body_size 0` and multer has no
  `limits`. If you ever reintroduce a cap, set it in both places to keep them in sync.

Backups: `backup.sh` runs nightly via cron on the droplet, doing a SQLite hot
backup (`.backup` + `integrity_check`) and rsyncing `slouch.db`, `uploads/`, and
`og-cache/` to rsync.net (ZFS daily snapshots give a year of history).
Full details in `BACKUPS.md`.

## Routes (all defined in server.js)

Public:
- `GET /` → splash page.
- `GET /:code` → if the code has a note, render the interstitial; otherwise
  301-redirect (link) or serve (file). Logs the click.
- `GET /:code/go` → skip the interstitial; redirect/serve directly. Logs the click.
- `GET /:code/og.png` → cached OG social card (lazily generated on cache miss;
  returns 503 + `Retry-After` on render timeout so unfurlers retry).
- `GET /:code/__og-html` → **internal only**, refuses non-loopback requests;
  the OG-mode HTML Puppeteer navigates to.

Admin (HTTP Basic Auth via `requireAuth`):
- `GET /admin`, plus `POST /api/shorten`, `POST /api/upload`,
  `GET /api/links`, `GET /api/files`,
  `PATCH /api/links/:code/note`, `PATCH /api/files/:code/note`,
  `DELETE /api/links/:code`, `DELETE /api/files/:code`,
  and `GET /api/stats`, `/api/stats/summary`, `/api/stats/top-links`,
  `/api/stats/top-files`, `/api/stats/detail/:code`.

Route ordering matters: the specific `/:code/og.png`, `/:code/__og-html`, and
`/:code/go` routes are registered before the catch-all `/:code`. Reserved codes
`admin` and `api` are rejected by `generateCode`.

## Data model (SQLite)

- `links` (code, url, title, note, clicks, timestamps)
- `files` (code, original_name, stored_name, mime_type, size, note, downloads, timestamps)
- `click_log` (per-hit: code, type, ip, user_agent, referer, is_bot, clicked_at)
- `ip_geo` (cache of IP → country/region/city from ipapi.co; populated lazily by
  `backfillGeo` when stats endpoints are hit)

Schema is created idempotently at startup (`CREATE TABLE IF NOT EXISTS`), and
`ensureColumn()` does additive migrations for columns added over time. New schema
changes should follow the same additive, in-code pattern — there is no migration
framework.

## Notes, the interstitial, and OG images (the tricky part)

This is where most of the subtlety lives; read the long comments in `server.js`
before touching it.

- A **note** is Markdown that may contain LaTeX. `extractMath` pulls math spans
  out *before* `marked` runs (so Markdown doesn't mangle them) and `restoreMath`
  puts them back, then DOMPurify sanitizes. `renderMarkdown` is the entry point;
  the allow-list of tags/attrs is deliberately tight.
- `renderInterstitial()` produces a single HTML template used for **three**
  surfaces: the live interstitial, and the OG-mode render (`og-mode` body class
  shrinks/reflows for the 1200×630 capture). Math vs. no-math changes which
  readiness script is injected.
- **OG rendering pipeline**: `pregenerateOgImage` (fire-and-forget on create/note-edit)
  → `generateOgImage` → `renderCodeToPng`, which drives Puppeteer to `page.goto`
  the internal `/__og-html` route. Key gotchas, all load-bearing:
  - Uses `goto` (not `setContent`) so relative `/vendor/...` script URLs resolve
    against a real origin.
  - The page sets `window.__ogReady = true` only after fonts (and MathJax, if
    present) finish; Puppeteer waits on that flag.
  - MathJax is loaded **synchronously** (no `async`) — async + Puppeteer's load
    event drops the script.
  - `page.screenshot()` returns a Uint8Array in recent Puppeteer; it's coerced to
    a Buffer (sending the Uint8Array directly silently corrupts the response).
  - A single shared browser instance is reused (`getBrowser`), recycled on wedge
    (`recycleBrowser`), and every render is bounded by `withTimeout`.
- After changing the interstitial design or the render pipeline, regenerate all
  cards with `tools/regen-og.js` on the droplet (old PNGs are cached).

## Conventions

- Plain CommonJS (`require`), Express 4. No TypeScript, no bundler, no client framework.
- Match the existing house style: section dividers (`// ─── … ───`), prepared
  statements grouped in `stmts`, and the verbose explanatory comments on anything
  non-obvious (especially the Puppeteer/MathJax code) — keep that comment density.
- Visual identity is "warm paper / ink" — serif (Crimson Pro) + mono (JetBrains
  Mono), CSS variables defined at the top of each HTML surface. Reuse the variables.
- Bot traffic is classified by `BOT_PATTERNS` and recorded as `is_bot` so stats can
  split humans from bots; keep new click-logging consistent with that.

## Gotchas

- `slouch.db`, `uploads/`, `og-cache/`, `node_modules/`, `.env`, and the real
  `slouch.service` are gitignored. Never commit secrets or user data.
- The app binds to `127.0.0.1` only; it's reachable publicly only through nginx.
- Geolocation calls out to ipapi.co (free tier, rate-limited) — `backfillGeo` is
  capped per request and caches results; don't make it aggressive.
- Deleting a link/file also unlinks the uploaded file (for files) and invalidates
  the OG cache; keep that cleanup intact when editing delete handlers.
