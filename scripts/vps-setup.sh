#!/usr/bin/env bash
# Instala en un VPS Ubuntu 24.04 un "runner" de GitHub Actions para
# Luxury Hunter. El bot sigue funcionando con el mismo workflow y los mismos
# secrets de GitHub, pero en tu servidor: sin esperas de cola y en bucle.
#
# Uso (como root en el VPS):
#   curl -fsSL https://raw.githubusercontent.com/nmuxart-star/luxury-hunter-worker/main/scripts/vps-setup.sh -o vps-setup.sh
#   bash vps-setup.sh <TOKEN_DE_REGISTRO>
# El token de registro lo genera Claude (caduca en 1 hora).
set -euo pipefail

TOKEN="${1:-}"
REPO_URL="https://github.com/nmuxart-star/luxury-hunter-worker"
RUNNER_USER="lhrunner"
RUNNER_DIR="/home/${RUNNER_USER}/actions-runner"

if [ -z "$TOKEN" ]; then
  echo "Falta el token de registro: bash vps-setup.sh <TOKEN>"
  exit 1
fi
if [ "$(id -u)" != "0" ]; then
  echo "Ejecuta este script como root (o con sudo)."
  exit 1
fi

echo "==> Actualizando el sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git jq unzip ca-certificates openssl fail2ban unattended-upgrades

echo "==> Seguridad básica: actualizaciones automáticas y bloqueo de ataques SSH"
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now fail2ban || true

echo "==> Memoria de intercambio (2 GB) para Chromium"
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Usuario del runner (${RUNNER_USER})"
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$RUNNER_USER"
fi
# El workflow instala dependencias de Chromium con apt: necesita sudo sin contraseña.
echo "${RUNNER_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${RUNNER_USER}"
chmod 440 "/etc/sudoers.d/${RUNNER_USER}"

echo "==> Descargando el runner de GitHub Actions"
VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')"
ARCH="x64"
[ "$(uname -m)" = "aarch64" ] && ARCH="arm64"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-${ARCH}-${VERSION}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
chown -R "$RUNNER_USER:$RUNNER_USER" "/home/${RUNNER_USER}"
./bin/installdependencies.sh

echo "==> Registrando el runner en GitHub"
sudo -u "$RUNNER_USER" ./config.sh --unattended --replace \
  --url "$REPO_URL" --token "$TOKEN" \
  --name "luxury-hunter-vps" --labels "lh-vps" --work "_work"

echo "==> Instalando como servicio (arranca solo al reiniciar)"
./svc.sh install "$RUNNER_USER"
./svc.sh start

echo
echo "Listo. El runner 'luxury-hunter-vps' está conectado a GitHub."
echo "Avisa a Claude para que cambie el bot a este servidor."
