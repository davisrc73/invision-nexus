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
APK_INPUT="${3:-}"
CHROME_PKG="com.android.chrome"
FULLY_PKG="de.ozerov.fully"

if [[ -z "$BOX_IP" ]]; then
  echo "Uso: $0 <IP_DA_BOX_X98_PLUS> [URL_DO_PLAYER_PWA] [CAMINHO_APK_FULLY_KIOSK]"
  echo "Exemplo: $0 192.168.68.115"
  echo "Exemplo com APK: $0 192.168.68.115 http://192.168.68.117:5174 ./tools/apk/fully-kiosk.apk"
  exit 1
fi

OS_TYPE="$(uname -s)"

# Determina automaticamente a porta ativa do Player a partir do .env (ex: 5174 no NAS)
ACTIVE_PLAYER_PORT="5173"
if [[ -f ".env" ]] && grep -q '^PLAYER_PORT=' .env; then
  ACTIVE_PLAYER_PORT="$(grep '^PLAYER_PORT=' .env | cut -d'=' -f2 | tr -d '[:space:]')"
fi

detect_lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"
    if [[ -z "$ip" ]]; then
      ip="$(ip -4 addr show 2>/dev/null | grep -oE '192\.168\.[0-9]+\.[0-9]+' | head -n1 || true)"
    fi
  fi
  if [[ -z "$ip" ]] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | grep -oE '192\.168\.[0-9]+\.[0-9]+' | grep -v '\.255$' | head -n1 || true)"
  fi
  echo "${ip:-192.168.68.117}"
}

if [[ -z "$USER_URL" ]]; then
  if [[ "$OS_TYPE" == "Linux" ]]; then
    HOST_IP="$(detect_lan_ip)"
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

echo "==> [2/7] A ativar ADB persistente no arranque e a desativar Sleep / Standby HDMI-CEC..."
# Garante que mesmo após desligar a Box da tomada, a porta 5555 ADB continua ativa após o boot
"${ADB_BIN}" -s "${BOX_IP}:5555" shell setprop persist.adb.tcp.port 5555 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell setprop service.adb.tcp.port 5555 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global stay_on_while_plugged_in 7 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put system screen_off_timeout 2147483647 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put secure sleep_timeout -1 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put secure screensaver_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global hdmi_control_auto_device_off_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global wifi_sleep_policy 2 || true

# Obtém o Android ID físico da placa da Box como fallback determinístico (sem alterar o ID já guardado no localStorage!)
RAW_ANDROID_ID="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell settings get secure android_id 2>/dev/null | tr -d '[:space:]' | cut -c1-6 | tr '[:lower:]' '[:upper:]' || echo 'BOX01')"
FALLBACK_HW_UID="X98-${RAW_ANDROID_ID}"

echo "==> [3/7] A configurar fuso horário Europe/Lisbon e sincronização automática NTP..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global auto_time 1 || true

echo "==> [4/7] A silenciar notificações visuais e ativar Immersive Mode (Full Kiosk)..."
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global heads_up_notifications_enabled 0 || true
"${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global policy_control "immersive.full=*" || true

echo "==> [5/7] A verificar e configurar motor de Kiosk (Fully Kiosk vs Google Chrome)..."
mkdir -p ./tools/apk

# Verifica se o Fully Kiosk Browser já se encontra instalado no sistema da Box
IS_FULLY_INSTALLED="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell pm path "${FULLY_PKG}" 2>/dev/null | grep "${FULLY_PKG}" || true)"

# Se não estiver instalado, procura ficheiro APK fornecido via argumento ou presente em ./tools/apk/
if [[ -z "${IS_FULLY_INSTALLED}" ]]; then
  APK_FILE=""
  if [[ -n "${APK_INPUT}" ]] && [[ -f "${APK_INPUT}" ]]; then
    APK_FILE="${APK_INPUT}"
  elif ls ./tools/apk/*fully*kiosk*.apk >/dev/null 2>&1; then
    APK_FILE="$(ls ./tools/apk/*fully*kiosk*.apk | head -n1)"
  elif ls ./tools/apk/*.apk >/dev/null 2>&1; then
    APK_FILE="$(ls ./tools/apk/*.apk | head -n1)"
  fi

  if [[ -n "${APK_FILE}" ]]; then
    echo "==> [APK] A instalar Fully Kiosk Browser (${APK_FILE}) na Box Android..."
    "${ADB_BIN}" -s "${BOX_IP}:5555" install -r -g "${APK_FILE}" || true
    IS_FULLY_INSTALLED="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell pm path "${FULLY_PKG}" 2>/dev/null | grep "${FULLY_PKG}" || true)"
  fi
fi

if [[ -n "${IS_FULLY_INSTALLED}" ]]; then
  echo "==> [6/7] Fully Kiosk DETETADO! A limpar instâncias anteriores e ativar Kiosk Permanente..."
  # Fecha qualquer instância anterior para não duplicar processos
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop "${CHROME_PKG}" || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop "${FULLY_PKG}" || true
  sleep 1

  # Define Fully Kiosk como aplicação Home nativa do Android (garante arranque autónomo no boot sem rede!)
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell cmd package set-home-activity de.ozerov.fully/.MainActivity || true

  # Inicia o Fully Kiosk com o URL alvo
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -n de.ozerov.fully/.MainActivity -d "${PLAYER_URL}"
  sleep 3

  # Injeta configurações oficiais de Kiosk, auto-arranque e cache offline via broadcast
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_STRING_SETTING --es key startUrl --es value "${PLAYER_URL}" || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key autostart --ez value true || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key kioskMode --ez value true || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key enableOfflineCache --ez value true || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key keepScreenOn --ez value true || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key sleepOnPowerConnect --ez value false || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key autoplayVideo --ez value true || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key showActionBar --ez value false || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key showStatusBar --ez value false || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key showNavigationKeys --ez value false || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am broadcast -a de.ozerov.fully.action.SET_BOOLEAN_SETTING --es key preventDeviceSleep --ez value true || true

  echo "🛡️  Fully Kiosk ativado com sucesso como Lançador Principal do Android!"
else
  echo "==> [6/7] Fully Kiosk não detetado. A limpar abas abertas e a reiniciar o Google Chrome..."
  # 1. Força a paragem do Chrome para fechar todas as abas e sessões anteriores
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop com.android.chrome || true
  # 2. Faz reset de abas acumuladas através de pm clear (elimina 100% das abas zombis anteriores)
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell pm clear com.android.chrome >/dev/null 2>&1 || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am clear-debug-app || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell rm -f /data/local/tmp/chrome-command-line || true
  # Re-aplica definições imersivas essenciais
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global stay_on_while_plugged_in 7 || true
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global policy_control "immersive.full=*" || true
  sleep 1

  # Garante que o URL leva o hw_uid determinístico da Box para manter sempre o mesmo registo e emparelhamento
  TARGET_LAUNCH_URL="${PLAYER_URL}"
  if [[ "${TARGET_LAUNCH_URL}" != *"hw_uid="* ]]; then
    if [[ "${TARGET_LAUNCH_URL}" == *"?"* ]]; then
      TARGET_LAUNCH_URL="${TARGET_LAUNCH_URL}&hw_uid=${FALLBACK_HW_UID}"
    else
      TARGET_LAUNCH_URL="${TARGET_LAUNCH_URL}?hw_uid=${FALLBACK_HW_UID}"
    fi
  fi

  # 3. Inicia o Chrome com FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK (0x10008000) garantindo UMA ÚNICA ABA LIMPA
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start \
    -n com.android.chrome/com.google.android.apps.chrome.Main \
    -a android.intent.action.VIEW \
    -d "${TARGET_LAUNCH_URL}" \
    -f 0x10008000 \
    --es com.android.browser.application_id com.android.chrome \
    --ez create_new_tab false 2>/dev/null || \
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${TARGET_LAUNCH_URL}" -f 0x10008000

  echo "==> [7/7] A aguardar carregamento do Chrome (4s) e ativar Fullscreen..."
  sleep 4
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 || true
  sleep 2
  "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 || true

  echo ""
  echo "💡 COMO INSTALAR O FULLY KIOSK BROWSER (Para arranque no boot sem rede e bloqueio total):"
  echo "   OPÇÃO A (Recomendada): Na própria Box Android, abre a Google Play Store e pesquisa 'Fully Kiosk Browser' -> Instalar."
  echo "   OPÇÃO B: No computador, acede a https://www.fully-kiosk.com/en/#download-box e clica no botão 'Download APK'."
  echo "            Coloca o ficheiro descarregado em ./tools/apk/ e corre novamente este script!"
  echo ""
fi

# Regista esta Box no Watchdog de Auto-Boot pós-reinício (servidor)
mkdir -p ./data/storage
touch ./data/storage/kiosk_boxes.conf
grep -v "^${BOX_IP}|" ./data/storage/kiosk_boxes.conf > ./data/storage/kiosk_boxes.conf.tmp || true
echo "${BOX_IP}|${PLAYER_URL}|${FALLBACK_HW_UID}" >> ./data/storage/kiosk_boxes.conf.tmp
mv ./data/storage/kiosk_boxes.conf.tmp ./data/storage/kiosk_boxes.conf

# Inicia o Watchdog em background se ainda não estiver a correr
chmod +x ./scripts/kiosk-watchdog.sh 2>/dev/null || true
if [[ ! -f "./data/storage/kiosk_watchdog.pid" ]] || ! kill -0 "$(cat ./data/storage/kiosk_watchdog.pid 2>/dev/null)" 2>/dev/null; then
  nohup bash ./scripts/kiosk-watchdog.sh >/dev/null 2>&1 &
fi

echo "✅ Provisionamento concluído na Box X98 Plus (${BOX_IP})!"
echo "   • URL Ativo: ${PLAYER_URL}"
echo "   • Modo Operacional: $([[ -n "${IS_FULLY_INSTALLED}" ]] && echo "Fully Kiosk Launcher (100% Autónomo no Boot sem rede)" || echo "Chrome PWA com Service Worker Offline-First")"
