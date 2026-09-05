#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT="${1:-$HOME/ai-goofish-monitor-wangdaguo/state/Nil.json}"
OUT="$ROOT/cloud/xianyu-state.enc"
if [ ! -f "$INPUT" ]; then
  echo "No encuentro el state de Xianyu: $INPUT" >&2
  exit 1
fi
mkdir -p "$ROOT/cloud"
echo "Se cifrará el state de Xianyu. Elige una contraseña larga y NO la olvides."
openssl enc -aes-256-cbc -salt -pbkdf2 -in "$INPUT" -out "$OUT"
chmod 600 "$OUT"
echo "OK: $OUT"
echo "Sube SOLO el .enc al repo. Nunca subas Nil.json sin cifrar."
