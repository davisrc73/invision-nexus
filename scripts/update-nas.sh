#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS (FNAC & DARTY) - ATUALIZAÇÃO AUTOMÁTICA NO SYNOLOGY NAS
# Deteta automaticamente portas livres no NAS para nunca falhar por conflito!
# Uso via SSH ou Task Scheduler no Synology NAS:
#   bash scripts/update-nas.sh [--build]
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

BEFORE_HEAD="$(git rev-parse HEAD 2>/dev/null || echo 'none')"

echo "==> [1/5] A descarregar as últimas evoluções do GitHub (git pull)..."
git pull origin main

AFTER_HEAD="$(git rev-parse HEAD 2>/dev/null || echo 'none')"

echo "==> [2/5] A garantir estrutura de pastas persistentes no Synology NAS..."
mkdir -p ./data/postgres ./data/redis ./data/storage/media ./data/storage/thumbs

# Função que verifica se uma porta TCP já está ocupada por outro serviço/contentor no NAS
is_port_busy() {
  local port="$1"
  local own_container="$2"

  # 1. Se o próprio contentor invision_* já estiver a correr nesta porta, a porta é nossa
  if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep "^${own_container} " | grep -q ":${port}->"; then
    return 1
  fi

  # 2. Verifica se outro contentor Docker tem esta porta mapeada
  if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -v "^${own_container} " | grep -q ":${port}->"; then
    return 0
  fi

  # 3. Verifica ao nível do sistema operativo (ss / netstat) se algum processo escuta na porta
  if command -v ss >/dev/null 2>&1; then
    if ss -tuln 2>/dev/null | awk '{print $5}' | grep -Eq "(^|:)${port}$"; then
      return 0
    fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -tuln 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:|\.)(${port})$"; then
      return 0
    fi
  fi

  return 1
}

pick_free_port() {
  local port="$1"
  local own_container="$2"
  while is_port_busy "$port" "$own_container"; do
    echo "   ⚠️  Porta ${port} já ocupada no NAS -> a selecionar porta seguinte $((port + 1))..." >&2
    port=$((port + 1))
  done
  echo "$port"
}

set_env_var() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s/^${key}=.*/${key}=${val}/" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

echo "==> [3/5] A inspecionar portas livres no Synology NAS (Auto-Port Scanner)..."
if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  cp .env.example .env
fi

FREE_PG_PORT="$(pick_free_port 5434 invision_postgres)"
FREE_REDIS_PORT="$(pick_free_port 6380 invision_redis)"
FREE_API_PORT="$(pick_free_port 3000 invision_backend)"
FREE_DASH_PORT="$(pick_free_port 4322 invision_dashboard)"
FREE_PLAYER_PORT="$(pick_free_port 5174 invision_player)"

set_env_var "POSTGRES_PORT" "${FREE_PG_PORT}"
set_env_var "REDIS_PORT" "${FREE_REDIS_PORT}"
set_env_var "API_PORT" "${FREE_API_PORT}"
set_env_var "DASHBOARD_PORT" "${FREE_DASH_PORT}"
set_env_var "PLAYER_PORT" "${FREE_PLAYER_PORT}"

echo "   ✔ Portas verificadas e livres no NAS:"
echo "     • Postgres:  ${FREE_PG_PORT}"
echo "     • Redis:     ${FREE_REDIS_PORT}"
echo "     • Backend:   ${FREE_API_PORT}"
echo "     • Dashboard: ${FREE_DASH_PORT}"
echo "     • Player:    ${FREE_PLAYER_PORT}"

# Só força --build se o código do backend/dashboard/player mudou, se as imagens ainda não existirem, ou se pedires --build
BUILD_FLAG=""
if [[ "${1:-}" == "--build" ]]; then
  BUILD_FLAG="--build"
elif ! docker image inspect invision-nexus-dashboard >/dev/null 2>&1 || \
     ! docker image inspect invision-nexus-player >/dev/null 2>&1 || \
     ! docker image inspect invision-nexus-backend >/dev/null 2>&1; then
  BUILD_FLAG="--build"
elif [[ "${BEFORE_HEAD}" != "${AFTER_HEAD}" ]]; then
  if git diff --name-only "${BEFORE_HEAD}" "${AFTER_HEAD}" 2>/dev/null | grep -Eq '^(backend|dashboard|player)/'; then
    BUILD_FLAG="--build"
  fi
fi

echo "==> [4/5] A iniciar contentores Docker no Synology NAS (${BUILD_FLAG:-arranque rápido sem rebuild})..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d ${BUILD_FLAG} --remove-orphans
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d ${BUILD_FLAG} --remove-orphans
elif [[ -x "/usr/local/bin/docker-compose" ]]; then
  /usr/local/bin/docker-compose up -d ${BUILD_FLAG} --remove-orphans
else
  echo "❌ Erro: 'docker compose' não encontrado no PATH do Synology NAS."
  exit 1
fi

echo "==> [5/5] A limpar imagens Docker antigas (libertar espaço no NAS)..."
docker image prune -f >/dev/null 2>&1 || true

# Garante que o Watchdog de Auto-Boot das Boxes Android continua a correr no NAS
chmod +x ./scripts/kiosk-watchdog.sh 2>/dev/null || true
if [[ -f "./data/storage/kiosk_boxes.conf" ]]; then
  if [[ ! -f "./data/storage/kiosk_watchdog.pid" ]] || ! kill -0 "$(cat ./data/storage/kiosk_watchdog.pid 2>/dev/null)" 2>/dev/null; then
    nohup bash ./scripts/kiosk-watchdog.sh >/dev/null 2>&1 &
  fi
fi

NAS_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'IP_DO_NAS')"
echo ""
echo "✅ Invision Nexus 100% ONLINE no Synology NAS!"
echo "   • Dashboard Central: http://${NAS_IP}:${FREE_DASH_PORT}"
echo "   • Edge Player PWA:   http://${NAS_IP}:${FREE_PLAYER_PORT}"
echo "   • API & Sync Engine: http://${NAS_IP}:${FREE_API_PORT}"
echo "   • PostgreSQL 16 NAS: Porta ${FREE_PG_PORT}"
echo "   • Redis 7 NAS:       Porta ${FREE_REDIS_PORT}"
