#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS (FNAC & DARTY) - ATUALIZAÇÃO AUTOMÁTICA NO SYNOLOGY NAS
# Uso via SSH ou Task Scheduler no Synology NAS:
#   bash scripts/update-nas.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "==> [1/4] A garantir estrutura de pastas persistentes no Synology NAS..."
mkdir -p ./data/postgres ./data/redis ./data/storage/media ./data/storage/thumbs

if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  echo "==> A criar ficheiro .env inicial a partir de .env.example..."
  cp .env.example .env
fi

echo "==> [2/4] A descarregar as últimas evoluções do GitHub (git pull)..."
git pull origin main

echo "==> [3/4] A reconstruir e atualizar os contentores Docker no NAS..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build --remove-orphans
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build --remove-orphans
elif [[ -x "/usr/local/bin/docker-compose" ]]; then
  /usr/local/bin/docker-compose up -d --build --remove-orphans
else
  echo "❌ Erro: 'docker compose' não encontrado no PATH do Synology NAS."
  exit 1
fi

echo "==> [4/4] A limpar imagens Docker antigas (libertar espaço no NAS)..."
docker image prune -f >/dev/null 2>&1 || true

NAS_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'IP_DO_NAS')"
echo "✅ Invision Nexus atualizado e a correr no Synology NAS!"
echo "   • Dashboard Central: http://${NAS_IP}:4321"
echo "   • Edge Player PWA:   http://${NAS_IP}:5173"
echo "   • API & Sync Engine: http://${NAS_IP}:3000"
