#!/bin/bash
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: no encuentro Node.js en PATH."
  exit 1
fi
PORT="$(grep '^PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8200}"
if command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "ERROR: el puerto $PORT ya esta en uso. Para primero el Luxury Hunter manual con Ctrl+C y vuelve a ejecutar este comando."
  exit 1
fi
LABEL="com.luxuryhunter.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
NODE_DIR="$(dirname "$NODE_BIN")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/background.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/background.err.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID/$LABEL"
echo "OK: Luxury Hunter queda ejecutandose en segundo plano y arrancara al iniciar sesion."
echo "URL: http://127.0.0.1:$PORT"
echo "Logs: $LOG_DIR/background.out.log"
echo "Estado: cd $APP_DIR && npm run background:status"
