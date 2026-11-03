#!/usr/bin/env bash
# Instala el puente local y un túnel SSH saliente al VPS de Luxury Hunter.
# La extensión de Chrome se carga aparte desde extension/onemap-mac.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HOME/Library/Application Support/LuxuryHunter/OneMap"
LEGACY_STATE="$ROOT/.onemap"
TOKEN_FILE="$STATE/bridge-token"
KEY_FILE="$STATE/mac-bridge-ssh"
HOST="${ONEMAP_VPS_HOST:-vps-bea32034.vps.ovh.net}"
USER_NAME="${ONEMAP_VPS_USER:-ubuntu}"
NODE="$(command -v node)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/LuxuryHunter"
BRIDGE_LABEL="com.luxuryhunter.onemap-mac-bridge"
TUNNEL_LABEL="com.luxuryhunter.onemap-mac-tunnel"

mkdir -p "$STATE" "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$STATE"
for FILE in bridge-token mac-bridge-ssh mac-bridge-ssh.pub; do
  if [ -f "$LEGACY_STATE/$FILE" ] && [ ! -f "$STATE/$FILE" ]; then
    cp "$LEGACY_STATE/$FILE" "$STATE/$FILE"
  fi
done
if [ ! -f "$TOKEN_FILE" ]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
if [ ! -f "$KEY_FILE" ]; then
  ssh-keygen -q -t ed25519 -N '' -C luxury-hunter-onemap-mac -f "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
cp "$ROOT/scripts/onemap-mac-bridge.mjs" "$STATE/onemap-mac-bridge.mjs"
chmod 600 "$STATE/onemap-mac-bridge.mjs"

cat > "$STATE/run-bridge.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ONEMAP_MAC_BRIDGE_TOKEN="\$(cat '$TOKEN_FILE')"
exec '$NODE' '$STATE/onemap-mac-bridge.mjs'
EOF
chmod 700 "$STATE/run-bridge.sh"

cat > "$PLIST_DIR/$BRIDGE_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$BRIDGE_LABEL</string>
<key>ProgramArguments</key><array><string>$STATE/run-bridge.sh</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOG_DIR/onemap-bridge.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/onemap-bridge-error.log</string>
</dict></plist>
EOF

cat > "$PLIST_DIR/$TUNNEL_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$TUNNEL_LABEL</string>
<key>ProgramArguments</key><array>
<string>/usr/bin/ssh</string><string>-N</string>
<string>-o</string><string>BatchMode=yes</string>
<string>-o</string><string>ExitOnForwardFailure=yes</string>
<string>-o</string><string>ServerAliveInterval=30</string>
<string>-o</string><string>ServerAliveCountMax=2</string>
<string>-i</string><string>$KEY_FILE</string>
<string>-R</string><string>127.0.0.1:8210:127.0.0.1:8210</string>
<string>$USER_NAME@$HOST</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOG_DIR/onemap-tunnel.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/onemap-tunnel-error.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST_DIR/$BRIDGE_LABEL.plist" "$PLIST_DIR/$TUNNEL_LABEL.plist"

for LABEL in "$BRIDGE_LABEL" "$TUNNEL_LABEL"; do
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$PLIST_DIR/$LABEL.plist"
  launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
done

GH="$(command -v gh || true)"
if [ -z "$GH" ] && [ -x "$HOME/bin/gh" ]; then GH="$HOME/bin/gh"; fi
if [ -n "$GH" ]; then
  "$GH" secret set ONEMAP_MAC_BRIDGE_TOKEN -R nmuxart-star/luxury-hunter-worker < "$TOKEN_FILE"
  echo 'Se ha guardado ONEMAP_MAC_BRIDGE_TOKEN en GitHub Actions.'
else
  echo "Falta gh: guarda $TOKEN_FILE como secreto ONEMAP_MAC_BRIDGE_TOKEN de GitHub Actions."
fi
if [ "${ONEMAP_SKIP_REMOTE_AUTH:-0}" = 1 ]; then
  echo 'Puente local preparado. Falta autorizar la clave SSH en el VPS desde un terminal interactivo.'
else
  echo "Conectando por SSH para autorizar solo el túnel de este Mac. Escribe la contraseña del VPS en el terminal cuando se solicite."
  printf 'restrict,port-forwarding,permitlisten="127.0.0.1:8210",command="/bin/false" %s\n' "$(cat "$KEY_FILE.pub")" |
    ssh -o StrictHostKeyChecking=accept-new "$USER_NAME@$HOST" \
      'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; read -r key; grep -Fqx "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys'
  echo 'Clave SSH autorizada en el VPS.'
fi
echo "Carga extension/onemap-mac en chrome://extensions/ y pega allí la clave de $TOKEN_FILE."
