#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS (FNAC & DARTY) - PROVISIONAMENTO AUTOMATIZADO ADB KIOSK
# Compatível com macOS (Darwin) e Synology NAS (Linux DSM)
# Hardware Alvo: Box Android X98 Plus (Allwinner/Amlogic, 4GB RAM, 64GB ROM)
# Uso: bash scripts/provision-x98-kiosk.sh <IP_DA_BOX_ANDROID> [URL_DO_PLAYER_PWA]
# ============================================================================

set -euo pipefail

BOX_IP="${1:-}"
USER_URL="${2:-}"
CHROME_PKG="com.android.chrome"

if [[ -z "$BOX_IP" ]]; then
  echo "Uso: $0 <IP_DA_BOX_X98_PLUS> [URL_DO_PLAYER_PWA]"
  echo "Exemplo: $0 192.168.68.115"
  exit 1
fi

OS_TYPE="$(uname -s)"

# Determina automaticamente a porta ativa do Player a partir do .env (ex: 5174 no NAS)
ACTIVE_PLAYER_PORT="5173"
if [[ -f ".env" ]] && grep -q '^PLAYER_PORT=' .env; then
  ACTIVE_PLAYER_PORT="$(grep '^PLAYER_PORT=' .env | cut -d'=' -f2 | tr -d '[:space:]')"
fi

if [[ -z "$USER_URL" ]]; then
  if [[ "$OS_TYPE" == "Linux" ]]; then
    HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '192.168.68.118')"
    PLAYER_URL="http://${HOST_IP}:${ACTIVE_PLAYER_PORT}"
  else
    PLAYER_URL="http://192.168.68.118:5173"
  fi
else
  PLAYER_URL="${USER_URL%/}"
  # Se estivermos no NAS onde o Player corre na 5174 (para não colidir com o BandOS na 5173) e o comando tiver :5173, corrige automaticamente!
  if [[ "$OS_TYPE" == "Linux" ]] && [[ "$ACTIVE_PLAYER_PORT" != "5173" ]] && [[ "$PLAYER_URL" == *":5173" ]]; then
    PLAYER_URL="${PLAYER_URL%:5173}:${ACTIVE_PLAYER_PORT}"
    echo "ℹ️  Nota: No teu NAS a porta 5173 está ocupada (BandOS) e o Player Invision Nexus corre na porta ${ACTIVE_PLAYER_PORT}."
    echo "   URL ajustado automaticamente para: ${PLAYER_URL}"
  fi
fi

# Define pasta de ferramentas específica para cada sistema operativo (macOS vs Linux Synology NAS)
if [[ "$OS_TYPE" == "Darwin" ]]; then
  PLATFORM_SUBDIR="darwin"
  GOOGLE_ZIP_URL="https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
else
  PLATFORM_SUBDIR="linux"
  GOOGLE_ZIP_URL="https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
fi

LOCAL_ADB="./tools/${PLATFORM_SUBDIR}/platform-tools/adb"

extract_zip() {
  local zip_file="$1"
  local dest_dir="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip_file" -d "$dest_dir"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$zip_file" "$dest_dir"
  elif command -v python >/dev/null 2>&1; then
    python -m zipfile -e "$zip_file" "$dest_dir"
  elif [[ -x "/usr/syno/bin/7z" ]]; then
    /usr/syno/bin/7z x -y "$zip_file" "-o${dest_dir}" >/dev/null
  elif command -v 7z >/dev/null 2>&1; then
    7z x -y "$zip_file" "-o${dest_dir}" >/dev/null
  elif command -v busybox >/dev/null 2>&1 && busybox unzip --help >/dev/null 2>&1; then
    busybox unzip -q -o "$zip_file" -d "$dest_dir"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$(pwd):/work" -w /work alpine sh -c "unzip -q -o '$zip_file' -d '$dest_dir'"
  else
    echo "❌ Erro: Nenhum utilitário de extração ZIP encontrado (python3, 7z, unzip ou docker)."
    exit 1
  fi
}

# Procura o binário 'adb' compatível com o sistema atual (Mac ou Synology NAS)
ADB_BIN=""
if command -v adb >/dev/null 2>&1 && adb version >/dev/null 2>&1; then
  ADB_BIN="$(command -v adb)"
elif [[ -x "/opt/homebrew/bin/adb" ]] && /opt/homebrew/bin/adb version >/dev/null 2>&1; then
  ADB_BIN="/opt/homebrew/bin/adb"
elif [[ -x "$LOCAL_ADB" ]] && "$LOCAL_ADB" version >/dev/null 2>&1; then
  ADB_BIN="$LOCAL_ADB"
elif [[ -x "./tools/platform-tools/adb" ]] && ./tools/platform-tools/adb version >/dev/null 2>&1; then
  ADB_BIN="./tools/platform-tools/adb"
else
  echo "==> [AUTO-SETUP] A instalar o utilitário 'adb' oficial da Google para ${OS_TYPE} (${PLATFORM_SUBDIR})..."
  mkdir -p "./tools/${PLATFORM_SUBDIR}"
  curl -L -sS "$GOOGLE_ZIP_URL" -o "./tools/${PLATFORM_SUBDIR}/platform-tools.zip"
  extract_zip "./tools/${PLATFORM_SUBDIR}/platform-tools.zip" "./tools/${PLATFORM_SUBDIR}"
  rm -f "./tools/${PLATFORM_SUBDIR}/platform-tools.zip"
  chmod +x "$LOCAL_ADB"
  ADB_BIN="$LOCAL_ADB"
  echo "==> [AUTO-SETUP] 'adb' instalado com sucesso em ${ADB_BIN}!"
fi

echo "==> [1/7] A ligar à Box Android X98 Plus em ${BOX_IP}:5555 (usando ${ADB_BIN})..."
"${ADB_BIN}" connect "${BOX_IP}:5555"

# Verifica se a Box aceitou a ligação ou se exige ativar "Depuração USB / Rede" nas Definições da Box
if ! "${ADB_BIN}" devices | grep -q "${BOX_IP}:5555.*device"; then
  echo ""
  echo "⚠️  ATENÇÃO: Não foi possível autenticar em ${BOX_IP}:5555 ou falta aceitar o popup na TV!"
  echo "    Verifica na Box Android X98 Plus:"
  echo "    1. Vai a Definições -> Acerca do Dispositivo -> Clica 7x em 'Número da compilação' (Build number)."
  echo "    2. Vai a Opções de Programador -> Ativa 'Depuração USB' (USB Debugging) e 'Depuração por Rede / Wireless Debugging'."
  echo "    3. Olha para a TV ligada à Box: se apareceu uma janela 'Permitir depuração USB?', marca 'Permitir sempre' e clica em OK!"
  echo ""
  exit 1
fi

echo "==> [2/7] A desativar Sleep, Screensaver Android e Standby HDMI-CEC..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global stay_on_while_plugged_in 7 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put system screen_off_timeout 2147483647 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put secure sleep_timeout -1 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put secure screensaver_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global hdmi_control_auto_device_off_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global wifi_sleep_policy 2 || true

echo "==> [3/7] A configurar fuso horário Europe/Lisbon e sincronização automática NTP..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global auto_time 1 || true

echo "==> [4/7] A silenciar notificações visuais e ativar Immersive Mode (Full Kiosk)..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global heads_up_notifications_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global policy_control "immersive.full=*" || true

echo "==> [5/7] A configurar flags Chromium para Fullscreen Kiosk, Autoplay Sem Gesto e GPU Decode..."
CMDLINE_FLAGS="chrome --no-first-run --disable-fre --no-default-browser-check --autoplay-policy=no-user-gesture-required --enable-accelerated-video-decode --ignore-gpu-blocklist --start-fullscreen --kiosk ${PLAYER_URL}"
"${ADB_BIN}" -s "${BOX_IP}:5555" shell "echo '${CMDLINE_FLAGS}' > /data/local/tmp/chrome-command-line" || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell chmod 666 /data/local/tmp/chrome-command-line || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell am set-debug-app --persistent "${CHROME_PKG}" || true

echo "==> [6/7] A reiniciar o Chrome (limpar cache visual antiga) e a abrir o Player PWA (${PLAYER_URL})..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop "${CHROME_PKG}" || true
sleep 1
CACHE_BUST_URL="${PLAYER_URL}/?kiosk=$(date +%s)"
"${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${CACHE_BUST_URL}" "${CHROME_PKG}" 2>/dev/null || \
"${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${CACHE_BUST_URL}"

echo "==> [7/7] A aguardar carregamento do Player (4s) e a esconder a barra de ferramentas do Chrome..."
sleep 4
"${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 || true
sleep 2
"${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 || true

echo "✅ Provisionamento concluído na Box X98 Plus (${BOX_IP})!"
echo "   O Player já está aberto em ${PLAYER_URL} na TV!"
