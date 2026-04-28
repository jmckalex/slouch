#!/bin/bash
# slou.ch — nightly backup to rsync.net
#
# Backs up:
#   - slouch.db    (via sqlite3 .backup, safe to run while service is writing)
#   - uploads/     (user-uploaded files)
#   - og-cache/    (rendered OG images; reproducible but slow to regenerate)
#
# Layout on rsync.net:
#   ~/slouch/      ← always-up-to-date mirror (rsync target)
#
# Point-in-time recovery is handled by rsync.net's ZFS snapshots
# (a year of daily snapshots is configured at the account level).
# Restore from history via ~/.zfs/snapshot/<name>/slouch/...
#
# Run as ghostuser from cron. See BACKUPS.md for setup.

set -euo pipefail

# ─── Configuration ───
SLOUCH_DIR="/var/www/slouch"
SSH_HOST="rsyncnet-backup"          # alias from ~/.ssh/config
REMOTE_DIR="slouch"                  # path on rsync.net (relative to home)
LOG_FILE="/var/log/slouch-backup.log"
LOCK_FILE="/tmp/slouch-backup.lock"

# ─── Logging ───
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

die() {
  log "ERROR: $*"
  exit 1
}

# ─── Lock (prevent overlapping runs) ───
exec 9>"$LOCK_FILE"
flock -n 9 || die "another backup run is in progress"

log "─── backup starting ───"

cd "$SLOUCH_DIR" || die "cannot cd to $SLOUCH_DIR"

# ─── 1. SQLite hot backup ───
# Using sqlite3's .backup command rather than copying slouch.db directly:
# this is safe even while the service is writing (handles WAL correctly).
STAGING_DB="/tmp/slouch.db.backup"
rm -f "$STAGING_DB"

log "creating SQLite hot backup"
sqlite3 "$SLOUCH_DIR/slouch.db" ".backup '$STAGING_DB'" \
  || die "sqlite3 .backup failed"

# Verify integrity before sending — a corrupt backup is worse than no backup
log "verifying backup integrity"
INTEGRITY=$(sqlite3 "$STAGING_DB" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  die "integrity check failed: $INTEGRITY"
fi

# Stage the verified DB inside the slouch dir so the rsync below picks it up.
# Use a different filename so we don't trample the live DB.
mv "$STAGING_DB" "$SLOUCH_DIR/slouch.db.backup"

# ─── 2. Push to rsync.net ───
# A single mirror directory; rsync.net's ZFS handles point-in-time history.
log "rsyncing to $SSH_HOST:$REMOTE_DIR/"
rsync -az --delete \
  --include='slouch.db.backup' \
  --include='uploads/***' \
  --include='og-cache/***' \
  --exclude='*' \
  "$SLOUCH_DIR/" \
  "$SSH_HOST:$REMOTE_DIR/" \
  >> "$LOG_FILE" 2>&1 \
  || die "rsync failed"

# ─── 3. Cleanup local staging file ───
rm -f "$SLOUCH_DIR/slouch.db.backup"

log "─── backup complete ───"
