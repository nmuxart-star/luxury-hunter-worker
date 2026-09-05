#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="$ROOT/cloud/config.json"
OUT="$ROOT/cloud/config.enc"
if [ ! -f "$IN" ]; then
  echo "Falta $IN. Ejecuta primero: npm run cloud:export" >&2
  exit 1
fi
echo "Se cifrará la configuración cloud (tareas, criterios y email destinatario)."
echo "Elige una contraseña larga. Después guárdala como GitHub Secret LUXURY_CONFIG_PASSWORD."
openssl enc -aes-256-cbc -salt -pbkdf2 -in "$IN" -out "$OUT"
chmod 600 "$OUT"
echo "OK: $OUT"
echo "cloud/config.json NO debe subirse al repositorio; cloud/config.enc sí."
