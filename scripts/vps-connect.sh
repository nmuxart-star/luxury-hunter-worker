#!/usr/bin/env bash
# Desde el Mac: genera un código de registro de GitHub (caduca en 1 h), entra
# en el VPS por SSH y ejecuta allí la instalación (scripts/vps-setup.sh).
# Solo pide la contraseña del servidor. Uso: bash scripts/vps-connect.sh [usuario] [host]
set -euo pipefail
USER_NAME="${1:-ubuntu}"
HOST="${2:-vps-bea32034.vps.ovh.net}"
GH="${HOME}/bin/gh"
REPO="nmuxart-star/luxury-hunter-worker"

TOKEN="$("$GH" api -X POST "repos/${REPO}/actions/runners/registration-token" -q .token)"
if [ -z "$TOKEN" ]; then
  echo "No se pudo generar el código de GitHub."
  exit 1
fi
echo "Conectando con ${USER_NAME}@${HOST}. Cuando pida 'password', escribe la contraseña del servidor (no se verá al escribir) y pulsa Enter."
echo "Si después pide '[sudo] password', vuelve a escribir la misma contraseña."
ssh -t -o StrictHostKeyChecking=accept-new "${USER_NAME}@${HOST}" \
  "curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/vps-setup.sh -o /tmp/vps-setup.sh && sudo bash /tmp/vps-setup.sh '${TOKEN}'"
