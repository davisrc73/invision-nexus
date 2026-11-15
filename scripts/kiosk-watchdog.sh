#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS - WATCHDOG DE AUTO-ARRANQUE KIOSK PÓS-REBOOT DAS BOXES X98
# Corre em background no Synology NAS (ou Mac) e verifica a cada 25 segundos
# se alguma Box Android X98 Plus reiniciou para o menu Home do Android.
# Se a Box tiver reiniciado, reabre automaticamente o Chrome no Player PWA
# mantendo exatamente o mesmo ID (hardwareUid) e o modo Fullscreen!
# ============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

CONF_FILE="./data/storage/kiosk_boxes.conf"
PID_FILE="./data/storage/kiosk_watchdog.pid"
CHROME_PKG="com.android.chrome"

mkdir -p ./data/storage
echo $$ > "${PID_FILE}"

find_adb() {
  if command -v adb >/dev/null 2>&1 && adb version >/dev/null 2>&1; then
    command -v adb
  elif [[ -x "./tools/linux/platform-tools/adb" ]]; then
    echo "./tools/linux/platform-tools/adb"
  elif [[ -x "./tools/darwin/platform-tools/adb" ]]; then
    echo "./tools/darwin/platform-tools/adb"
  elif [[ -x "./tools/platform-tools/adb" ]]; then
    echo "./tools/platform-tools/adb"
  else
    echo ""
  fi
}

while true; do
  ADB_BIN="$(find_adb)"
  if [[ -n "${ADB_BIN}" ]] && [[ -f "${CONF_FILE}" ]]; then
    while IFS='|' read -r BOX_IP PLAYER_URL HW_UID; do
      [[ -z "${BOX_IP}" || "${BOX_IP}" == \#* ]] && continue

      # Tenta ligar silenciosamente à Box (caso tenha acabado de reiniciar)
      "${ADB_BIN}" connect "${BOX_IP}:5555" >/dev/null 2>&1 || true

      if "${ADB_BIN}" devices 2>/dev/null | grep -q "${BOX_IP}:5555.*device"; then
        # Verifica qual a janela em primeiro plano na TV
        FOCUSED_APP="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' || true)"

        # Se o Chrome não estiver em primeiro plano (ex: a Box reiniciou e está no Launcher do Android)
        if [[ -n "${FOCUSED_APP}" ]] && ! echo "${FOCUSED_APP}" | grep -q "${CHROME_PKG}"; then
          TARGET_URL="${PLAYER_URL}"
          if [[ -n "${HW_UID:-}" ]]; then
            TARGET_URL="${PLAYER_URL}/?hw_uid=${HW_UID}"
          fi
          echo "[$(date '+%Y-%m-%d %H:%M:%S')] Box ${BOX_IP} reiniciou ou saiu do Kiosk. A relançar ${TARGET_URL}..."
          "${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global policy_control "immersive.full=*" >/dev/null 2>&1 || true
          "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${TARGET_URL}" "${CHROME_PKG}" >/dev/null 2>&1 || \
          "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${TARGET_URL}" >/dev/null 2>&1 || true
          sleep 5
          "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 >/dev/null 2>&1 || true
          sleep 2
          "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 >/dev/null 2>&1 || true
        fi
      fi
    done < "${CONF_FILE}"
  fi
  sleep 25
done
