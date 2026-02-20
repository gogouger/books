#!/usr/bin/env bash
set -euo pipefail

PROJ="/home/andymac/projects/books"
DEST="/data/containers/books"

echo "=== Building UI ==="
cd "$PROJ/books/ui"
npx esbuild src/main.ts --bundle --outfile=dist/app.js --target=es2020 --format=iife

echo "=== Syncing UI dist ==="
mkdir -p "$DEST/client"
rsync -a "$PROJ/books/ui/index.html" "$DEST/client/"
rsync -a "$PROJ/books/ui/style.css" "$DEST/client/"
rsync -a "$PROJ/books/ui/favicon.svg" "$DEST/client/"
rsync -a --delete "$PROJ/books/ui/dist/" "$DEST/client/dist/"

echo "=== Syncing API source ==="
mkdir -p "$DEST/api"
rsync -a --delete "$PROJ/pyproject.toml" "$DEST/api/pyproject.toml"
rsync -a --delete "$PROJ/uv.lock" "$DEST/api/uv.lock"
rsync -a --delete "$PROJ/README.md" "$DEST/api/README.md"
rsync -a --delete --exclude ui "$PROJ/books/" "$DEST/api/books/"

echo "=== Syncing config ==="
cp "$PROJ/.env" "$DEST/api/.env"
cp "$PROJ/nginx.conf" "$DEST/nginx.conf"
cp "$PROJ/docker-compose.yml" "$DEST/docker-compose.yml"

echo "=== Syncing scripts ==="
mkdir -p "$DEST/scripts"
rsync -a --delete "$PROJ/scripts/" "$DEST/scripts/"

echo "=== Building containers ==="
cd "$DEST"
docker compose build

echo "=== Restarting ==="
docker compose up -d

echo "=== Done ==="
docker compose ps
