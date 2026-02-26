#!/usr/bin/env bash
# Publish the KOReader BookSync plugin to the server.
# Reads credentials from .env and uploads the two Lua files
# to the /api/kobo/plugin/publish endpoint.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env
ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at $ENV_FILE" >&2
    exit 1
fi

get_env() {
    grep "^$1=" "$ENV_FILE" | head -1 | cut -d'=' -f2-
}

SERVER_URL="$(get_env BOOKS_SERVER_URL)"
DEPLOY_USER="$(get_env BOOKS_DEPLOY_USER)"
DEPLOY_PASS="$(get_env BOOKS_DEPLOY_PASS)"

if [[ -z "$SERVER_URL" ]]; then
    echo "Error: BOOKS_SERVER_URL not set in .env" >&2
    exit 1
fi
if [[ -z "$DEPLOY_USER" || -z "$DEPLOY_PASS" ]]; then
    echo "Error: BOOKS_DEPLOY_USER and BOOKS_DEPLOY_PASS must be set in .env" >&2
    exit 1
fi

PLUGIN_DIR="$PROJECT_DIR/koreader/plugins/booksync.koplugin"
META_LUA="$PLUGIN_DIR/_meta.lua"
MAIN_LUA="$PLUGIN_DIR/main.lua"

if [[ ! -f "$META_LUA" || ! -f "$MAIN_LUA" ]]; then
    echo "Error: Plugin files not found in $PLUGIN_DIR" >&2
    exit 1
fi

echo "Publishing plugin to $SERVER_URL ..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
    -u "$DEPLOY_USER:$DEPLOY_PASS" \
    -F "meta_lua=@$META_LUA" \
    -F "main_lua=@$MAIN_LUA" \
    "$SERVER_URL/api/kobo/plugin/publish")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
    echo "Success: $BODY"
else
    echo "Error (HTTP $HTTP_CODE): $BODY" >&2
    exit 1
fi
