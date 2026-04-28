# slou.ch — backup setup

Nightly backups of `slouch.db`, `uploads/`, and `og-cache/` to rsync.net.

## What gets backed up

- **`slouch.db`** — captured via `sqlite3 .backup` (a hot backup safe to run
  while the service is writing), then `PRAGMA integrity_check` before sending.
- **`uploads/`** — user-uploaded files, irreplaceable.
- **`og-cache/`** — rendered OG images. Reproducible via `regen-og.js` but
  slow, so backed up too.

## Layout on rsync.net

```
~/slouch/                ← always-up-to-date mirror (rsync target)
~/.zfs/snapshot/<name>/  ← read-only ZFS snapshots, year of daily history
```

The script just maintains the live mirror at `~/slouch/`. Point-in-time
recovery is handled at the rsync.net account level by ZFS daily snapshots
(immutable; configured to retain a year). To restore from a specific day,
read from `~/.zfs/snapshot/<snapshot-name>/slouch/...`.

---

## One-time setup

All steps run on the droplet as `ghostuser` unless noted otherwise.

### 1. Generate a dedicated SSH key

rsync.net recommends ECDSA keys and provides specific instructions for
their environment. We follow those literally, with one small adaptation
(non-default filename so the key is distinguishable from any existing key
at `~/.ssh/id_ecdsa`).

```bash
ssh trocp
sudo -u ghostuser -i

ssh-keygen -t ecdsa -f ~/.ssh/id_ecdsa_rsyncnet -C "slouch-backup@trocp"
```

When prompted for a passphrase, hit enter twice (empty passphrase). The
key must be passphraseless because cron runs unattended.

The key is dedicated to this one purpose, so its blast radius if
compromised is "can write to rsync.net backup vault" — nothing else.

### 2. Authorise the key on rsync.net

rsync.net runs a restricted, chrooted shell, so the usual `cat >> ...`
approach for appending an authorised key doesn't behave as expected. Use
rsync.net's documented `dd`-based form (from their "Multiple Keys"
section) — this works correctly inside their environment.

From the droplet, as `ghostuser`:

```bash
cat ~/.ssh/id_ecdsa_rsyncnet.pub | \
  ssh <YOUR_ACCOUNT>@<YOUR_ACCOUNT>.rsync.net \
    'dd of=.ssh/authorized_keys oflag=append conv=notrunc'
```

You'll be prompted for your rsync.net password — this is the last time.

**Important:** do NOT run `chmod` on `~/.ssh/`, `~/.ssh/authorized_keys`,
or your home directory on the rsync.net side. Their chrooted environment
sets these correctly already, and changing them breaks key auth silently.
This is the opposite of typical SSH guidance and is specific to rsync.net.

### 3. Add an SSH config entry

On the droplet, as `ghostuser`:

```bash
cat >> ~/.ssh/config <<'EOF'

Host rsyncnet-backup
  HostName <YOUR_ACCOUNT>.rsync.net
  User <YOUR_ACCOUNT>
  IdentityFile ~/.ssh/id_ecdsa_rsyncnet
  IdentitiesOnly yes
  ServerAliveInterval 60
  ServerAliveCountMax 60
EOF

chmod 600 ~/.ssh/config
```

Replace `<YOUR_ACCOUNT>` with your rsync.net account name (the same one you
use from your Mac). `IdentitiesOnly yes` is important — without it, SSH will
offer every key in the agent before this one, which can hit rsync.net's
failed-auth limits. The `ServerAlive*` settings stop a long-running rsync
from being silently dropped by an intermediate firewall during idle periods.

### 4. Test the connection

```bash
ssh rsyncnet-backup quota
```

Should print your account's disk quota information without prompting for a
password. (rsync.net runs a restricted shell rather than a full login
shell — `quota`, `ls`, `mkdir`, `rm`, `mv`, and `rsync` itself are
available; arbitrary shell pipelines are not.)

If it prompts for a password, the key isn't authorised yet — re-check
step 2.

### 5. Install the backup script

The script ships with the project as `backup.sh`. Make it executable and
ensure the log file is writable:

```bash
sudo chmod +x /var/www/slouch/backup.sh
sudo touch /var/log/slouch-backup.log
sudo chown ghostuser:ghostuser /var/log/slouch-backup.log
```

### 6. Run it manually once

Before wiring up cron, confirm a full run works end-to-end:

```bash
sudo -u ghostuser /var/www/slouch/backup.sh
tail -50 /var/log/slouch-backup.log
```

You should see lines for: backup starting → SQLite hot backup → integrity
check → rsync → backup complete. On rsync.net you should now have
`~/slouch/` populated with `slouch.db.backup`, `uploads/`, and `og-cache/`.

### 7. Schedule via cron

Edit `ghostuser`'s crontab:

```bash
sudo -u ghostuser crontab -e
```

Add a nightly run at 03:17 (offset from the hour to avoid the cron-stampede
hour, and out-of-hours for likely user activity):

```
17 3 * * * /var/www/slouch/backup.sh
```

Cron's `PATH` is minimal, but the script uses absolute paths and the SSH
config alias, so it should just work. The script logs every run, so a quiet
crontab is fine.

---

## Restore

### Restore from the latest mirror

```bash
# On the droplet, stop the service first:
sudo systemctl stop slouch

# Pull from rsync.net into a staging area:
sudo -u ghostuser rsync -az --delete \
  rsyncnet-backup:slouch/ \
  /var/www/slouch-restore/

# Move into place. The DB is named slouch.db.backup in the mirror;
# rename to slouch.db when restoring.
sudo -u ghostuser mv /var/www/slouch-restore/slouch.db.backup \
  /var/www/slouch/slouch.db
sudo -u ghostuser cp -r /var/www/slouch-restore/uploads/* \
  /var/www/slouch/uploads/ 2>/dev/null || true
sudo -u ghostuser cp -r /var/www/slouch-restore/og-cache/* \
  /var/www/slouch/og-cache/ 2>/dev/null || true

sudo systemctl start slouch
```

### Restore from a historical ZFS snapshot

ZFS snapshots are exposed read-only under `~/.zfs/snapshot/<name>/` on
rsync.net. Their names follow rsync.net's convention (typically
`daily_YYYY-MM-DD` or similar — confirm via `ls .zfs/snapshot/` on
rsync.net).

```bash
# List available snapshots:
ssh rsyncnet-backup ls .zfs/snapshot/

# Pull from a specific snapshot:
sudo -u ghostuser rsync -az \
  rsyncnet-backup:.zfs/snapshot/daily_2026-04-15/slouch/ \
  /var/www/slouch-restore/
```

Then proceed as in the latest-mirror restore above.

### Recover just the database from a snapshot

```bash
# List snapshots, pick one:
ssh rsyncnet-backup ls .zfs/snapshot/

# Pull just the DB:
sudo -u ghostuser rsync -az \
  rsyncnet-backup:.zfs/snapshot/daily_2026-04-15/slouch/slouch.db.backup \
  /tmp/

# Verify before swapping:
sqlite3 /tmp/slouch.db.backup "PRAGMA integrity_check;"
sqlite3 /tmp/slouch.db.backup "SELECT COUNT(*) FROM links;"

sudo systemctl stop slouch
sudo -u ghostuser cp /tmp/slouch.db.backup /var/www/slouch/slouch.db
sudo systemctl start slouch
```

---

## Operational notes

- **Logs.** All runs append to `/var/log/slouch-backup.log`. Rotate if it
  ever gets unwieldy, but a one-line-per-step log over years is small.
- **Failures.** The script exits non-zero on any error and logs an
  `ERROR:` line. Cron will mail `ghostuser` if the script fails, assuming
  the droplet has any kind of mail relay; if not, you might want to set up
  a dead-man's-switch ping (e.g. healthchecks.io) — but for a personal
  endpoint, occasionally tailing the log file is probably enough.
- **Lock file.** The script uses `flock` on `/tmp/slouch-backup.lock` so
  overlapping runs (e.g. a stuck rsync session) don't corrupt each other.
- **Hot backup correctness.** `sqlite3 .backup` is the only safe way to
  copy a live SQLite database — a plain `cp` of `slouch.db` while the
  service is writing can produce a corrupt copy because of WAL semantics.
  This is why the script uses it even though `cp` would be shorter.
- **Retention is rsync.net's job.** The script intentionally maintains
  only a single mirror directory; ZFS snapshots at the rsync.net account
  level (a year of daily snapshots) provide point-in-time history. This
  is much cheaper, more robust, and immutable from the droplet's side —
  even a compromised droplet can't delete or alter old snapshots.
