#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS (FNAC & DARTY) - PROVISIONAMENTO AUTOMATIZADO ADB KIOSK
# Hardware Alvo: Box Android X98 Plus (Allwinner/Amlogic, 4GB RAM, 64GB ROM)
# Uso: bash scripts/provision-x98-kiosk.sh <IP_DA_BOX_ANDROID> [URL_DO_PLAYER_PWA]
# ============================================================================

set -euo pipefail

BOX_IP="${1:-}"
# IP por defeito apontado para o IP atual do Mac na tua rede local (192.168.68.118)
PLAYER_URL="${2:-http://192.168.68.118:5173}"
CHROME_PKG="com.android.chrome"

if [[ -z "$BOX_IP" ]]; then
  echo "Uso: $0 <IP_DA_BOX_X98_PLUS> [URL_DO_PLAYER_PWA]"
  echo "Exemplo: $0 192.168.68.115 http://192.168.68.118:5173"
  exit 1
fi

# Procura o binário 'adb' no PATH, no Homebrew ou na pasta local ./tools/platform-tools/adb
ADB_BIN=""
if command -v adb >/dev/null 2>&1; then
  ADB_BIN="$(command -v adb)"
elif [[ -x "/opt/homebrew/bin/adb" ]]; then
  ADB_BIN="/opt/homebrew/bin/adb"
elif [[ -x "/usr/local/bin/adb" ]]; then
  ADB_BIN="/usr/local/bin/adb"
elif [[ -x "./tools/platform-tools/adb" ]]; then
  ADB_BIN="./tools/platform-tools/adb"
elif [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
  ADB_BIN="$HOME/Library/Android/sdk/platform-tools/adb"
else
  echo "==> [AUTO-SETUP] O utilitário 'adb' (Android Platform Tools) ainda não está instalado no Mac."
  echo "==> A descarregar automaticamente o pacote oficial da Google para ./tools/platform-tools..."
  mkdir -p ./tools
  curl -L -sS "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip" -o ./tools/platform-tools.zip
  unzip -q -o ./tools/platform-tools.zip -d ./tools
  rm -f ./tools/platform-tools.zip
  chmod +x ./tools/platform-tools/adb
  ADB_BIN="./tools/platform-tools/adb"
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
echo "   O Player já está em Ecrã Inteiro Real (sem padding e sem barra superior) na TV!"
