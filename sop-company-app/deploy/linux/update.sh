#!/usr/bin/env bash
set -euo pipefail

APP_SLUG="${APP_SLUG:-sop-company-app}"
APP_DIR="${APP_DIR:-/opt/$APP_SLUG}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root."
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App directory not found: $APP_DIR"
  exit 1
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'data/documents' \
    --exclude '.env' \
    "$PROJECT_ROOT"/ "$APP_DIR"/
else
  cp -R "$PROJECT_ROOT"/. "$APP_DIR"/
fi

systemctl restart "$APP_SLUG.service"
systemctl status "$APP_SLUG.service" --no-pager
