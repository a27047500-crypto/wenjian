#!/usr/bin/env bash
set -euo pipefail

APP_SLUG="${APP_SLUG:-sop-company-app}"
DATA_ROOT="${DATA_ROOT:-/var/lib/$APP_SLUG/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/$APP_SLUG}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/$APP_SLUG-$STAMP.tar.gz"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "Data directory not found: $DATA_ROOT"
  exit 1
fi

tar -czf "$ARCHIVE" -C "$DATA_ROOT" .
echo "Backup created: $ARCHIVE"
