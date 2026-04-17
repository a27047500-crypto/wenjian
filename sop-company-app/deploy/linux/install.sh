#!/usr/bin/env bash
set -euo pipefail

APP_SLUG="${APP_SLUG:-sop-company-app}"
APP_USER="${APP_USER:-flowdocs}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/$APP_SLUG}"
DATA_ROOT="${DATA_ROOT:-/var/lib/$APP_SLUG/data}"
ENV_FILE="${ENV_FILE:-/etc/$APP_SLUG.env}"
SERVICE_FILE="/etc/systemd/system/$APP_SLUG.service"
NGINX_FILE="/etc/nginx/sites-available/$APP_SLUG.conf"
PORT="${PORT:-3100}"
HOST="${HOST:-127.0.0.1}"
DOMAIN="${DOMAIN:-_}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
SESSION_COOKIE_SECURE="${SESSION_COOKIE_SECURE:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root."
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 18+ is required. Install Node.js first, then rerun."
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18+ is required. Current version: $("$NODE_BIN" -v)"
  exit 1
fi

if [[ -z "$SESSION_COOKIE_SECURE" ]]; then
  if [[ "$DOMAIN" == "_" ]]; then
    SESSION_COOKIE_SECURE="false"
  else
    SESSION_COOKIE_SECURE="true"
  fi
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$APP_SLUG" --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR" "$DATA_ROOT/documents"

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

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
APP_NAME=Flow Docs
HOST=$HOST
PORT=$PORT
DATA_ROOT=$DATA_ROOT
SESSION_COOKIE_NAME=sop_session
SESSION_COOKIE_SECURE=$SESSION_COOKIE_SECURE
EOF
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Flow Docs Service
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [[ -d /etc/nginx/sites-available ]]; then
  cat > "$NGINX_FILE" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  ln -sf "$NGINX_FILE" "/etc/nginx/sites-enabled/$APP_SLUG.conf"
  if [[ -L /etc/nginx/sites-enabled/default || -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR" "$DATA_ROOT"

systemctl daemon-reload
systemctl enable "$APP_SLUG.service"
systemctl restart "$APP_SLUG.service"

if command -v nginx >/dev/null 2>&1 && [[ -f "$NGINX_FILE" ]]; then
  nginx -t
  systemctl reload nginx
fi

echo
echo "Installed to: $APP_DIR"
echo "Data root: $DATA_ROOT"
echo "Service: $APP_SLUG.service"
echo "Check status with: systemctl status $APP_SLUG.service --no-pager"
