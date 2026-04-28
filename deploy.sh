#!/bin/bash
# Deploy slouch to the droplet via rsync.
# Run from the project root: ./deploy.sh

set -e

echo "→ Syncing files to droplet..."
rsync -rlptDvz --delete \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  --exclude='node_modules' \
  --exclude='slouch.db' \
  --exclude='slouch.db-shm' \
  --exclude='slouch.db-wal' \
  --exclude='uploads' \
  --exclude='og-cache' \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='deploy.sh' \
  --exclude='slouch.service' \
  --exclude='slouch.service.example' \
  --exclude='.DS_Store' \
  ./ trocp:/var/www/slouch/

echo "→ Fixing ownership..."
ssh trocp 'sudo chown -R ghostuser:ghostuser /var/www/slouch'

echo "→ Restarting slouch service..."
ssh trocp 'sudo systemctl restart slouch'

echo "✓ Deployed."
