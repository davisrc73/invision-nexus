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
        BOOT_DONE="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]' || true)"
        [[ "${BOOT_DONE}" != "1" ]] && continue

        # Verifica de forma ultra-rápida qual a Activity em primeiro plano na TV e se Chrome ou Fully Kiosk estão a correr
        RESUMED_OUT="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell 'dumpsys activity activities | grep -iE "ResumedActivity|mFocusedApp" | head -n 4; echo "CHROME_PID:$(pidof com.android.chrome)"; echo "FULLY_PID:$(pidof de.ozerov.fully)"' 2>/dev/null || true)"

        IS_FULLY_ACTIVE=0
        if echo "${RESUMED_OUT}" | grep -E "ResumedActivity|mFocusedApp" | grep -q "de.ozerov.fully"; then
          IS_FULLY_ACTIVE=1
        fi

        IS_CHROME_ACTIVE=0
        if echo "${RESUMED_OUT}" | grep -E "ResumedActivity|mFocusedApp" | grep -q "${CHROME_PKG}"; then
          IS_CHROME_ACTIVE=1
        fi

        # Se nenhum Player estiver em primeiro plano (ex: a Box reiniciou e está no Desktop do Android)
        if [[ "$IS_FULLY_ACTIVE" -eq 0 && "$IS_CHROME_ACTIVE" -eq 0 ]]; then
          echo "[$(date '+%Y-%m-%d %H:%M:%S')] Box ${BOX_IP} fora do Player (Desktop Android). A recuperar..."
          if "${ADB_BIN}" -s "${BOX_IP}:5555" shell pm path de.ozerov.fully 2>/dev/null | grep -q "de.ozerov.fully"; then
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop de.ozerov.fully >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell cmd package set-home-activity de.ozerov.fully/.MainActivity >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -n de.ozerov.fully/.MainActivity -d "${PLAYER_URL}" >/dev/null 2>&1 || true
          else
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop com.android.chrome >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell su -c "rm -rf /data/data/com.android.chrome/app_tabs/*" >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell rm -rf /data/data/com.android.chrome/app_tabs/* >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am clear-debug-app >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell rm -f /data/local/tmp/chrome-command-line >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell settings put global policy_control "immersive.full=*" >/dev/null 2>&1 || true
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start \
              -n com.android.chrome/com.google.android.apps.chrome.Main \
              -a android.intent.action.VIEW \
              -d "${PLAYER_URL}" \
              -f 0x10008000 \
              --es com.android.browser.application_id com.android.chrome \
              --ez create_new_tab false >/dev/null 2>&1 || \
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell am start -a android.intent.action.VIEW -d "${PLAYER_URL}" -f 0x10008000 >/dev/null 2>&1 || true
            sleep 4
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 >/dev/null 2>&1 || true
            sleep 2
            "${ADB_BIN}" -s "${BOX_IP}:5555" shell input tap 960 540 >/dev/null 2>&1 || true
          fi
        fi
      fi
    done < "${CONF_FILE}"
  fi
  sleep 12
done

