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

echo "==> [1/5] A descarregar as últimas evoluções do GitHub (git pull)..."
git pull origin main

echo "==> [2/5] A garantir estrutura de pastas persistentes no Synology NAS..."
mkdir -p ./data/postgres ./data/redis ./data/storage/media ./data/storage/thumbs

echo "==> [3/5] A validar portas no .env (evitar conflito com PostgreSQL 5432 do DSM e BandOS)..."
if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  cp .env.example .env
fi

if [[ -f .env ]]; then
  # No Synology DSM, a porta 5432 é usada pelo sistema operativo DSM e a 5433 pelo BandOS.
  # Garantimos automaticamente que o Invision Nexus usa 5434 (Postgres) e 6380 (Redis).
  sed -i 's/^POSTGRES_PORT=5432$/POSTGRES_PORT=5434/' .env 2>/dev/null || true
  sed -i 's/^REDIS_PORT=6379$/REDIS_PORT=6380/' .env 2>/dev/null || true

  # Se o contentor bandaos-frontend estiver a usar a porta 5173 no NAS, usa 5174 para o Player
  if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -v 'invision_player' | grep -q ':5173->'; then
    echo "ℹ️  Porta 5173 já em uso no NAS (ex: BandOS). A configurar PLAYER_PORT=5174..."
    if grep -q '^PLAYER_PORT=' .env; then
      sed -i 's/^PLAYER_PORT=.*/PLAYER_PORT=5174/' .env 2>/dev/null || true
    else
      echo "PLAYER_PORT=5174" >> .env
    fi
  fi
fi

echo "==> [4/5] A iniciar/atualizar os contentores Docker no Synology NAS..."
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

echo "==> [5/5] A limpar imagens Docker antigas (libertar espaço no NAS)..."
docker image prune -f >/dev/null 2>&1 || true

ACTIVE_PLAYER_PORT="5173"
if [[ -f .env ]] && grep -q '^PLAYER_PORT=' .env; then
  ACTIVE_PLAYER_PORT="$(grep '^PLAYER_PORT=' .env | cut -d'=' -f2 | tr -d '[:space:]')"
fi

NAS_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'IP_DO_NAS')"
echo ""
echo "✅ Invision Nexus atualizado e a correr no Synology NAS!"
echo "   • Dashboard Central: http://${NAS_IP}:4321"
echo "   • Edge Player PWA:   http://${NAS_IP}:${ACTIVE_PLAYER_PORT}"
echo "   • API & Sync Engine: http://${NAS_IP}:3000"
echo "   • PostgreSQL 16 NAS: Porta externa 5434 (interna 5432)"
echo "   • Redis 7 NAS:       Porta externa 6380 (interna 6379)"
