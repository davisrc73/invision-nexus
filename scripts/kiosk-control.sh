#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS — CONTROLO DE KIOSK & MANUTENÇÃO DE BOXES ANDROID X98 PLUS
# Permite parar o Player, pausar/retomar o Watchdog, verificar a instalação
# do Fully Kiosk Browser e limpar 100% das abas acumuladas no Chrome.
# ============================================================================

set -u

CMD="${1:-help}"
BOX_IP="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

find_adb() {
  if command -v adb >/dev/null 2>&1 && adb version >/dev/null 2>&1; then
    command -v adb
  elif [[ -x "./tools/darwin/platform-tools/adb" ]]; then
    echo "./tools/darwin/platform-tools/adb"
  elif [[ -x "./tools/linux/platform-tools/adb" ]]; then
    echo "./tools/linux/platform-tools/adb"
  elif [[ -x "./tools/platform-tools/adb" ]]; then
    echo "./tools/platform-tools/adb"
  else
    echo "adb"
  fi
}

ADB_BIN="$(find_adb)"

# Se não foi fornecido IP da Box, tenta ler a primeira do conf
if [[ -z "${BOX_IP}" ]] && [[ -f "./data/storage/kiosk_boxes.conf" ]]; then
  BOX_IP="$(grep -v '^#' ./data/storage/kiosk_boxes.conf | head -n1 | cut -d'|' -f1 | tr -d '[:space:]')"
fi

case "${CMD}" in
  stop|stop-player|kill)
    echo "🛑 A parar o Player na Box e a suspender o Watchdog..."
    # 1. Mata o processo Watchdog local em background se existir
    if [[ -f "./data/storage/kiosk_watchdog.pid" ]]; then
      PID="$(cat ./data/storage/kiosk_watchdog.pid 2>/dev/null)"
      if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
        kill -9 "${PID}" 2>/dev/null || true
        echo "   • Watchdog local (PID ${PID}) terminado."
      fi
      rm -f ./data/storage/kiosk_watchdog.pid
    fi

    # 2. Informa o Backend para pausar o Watchdog da Box
    if [[ -n "${BOX_IP}" ]]; then
      curl -s -X POST http://127.0.0.1:3000/api/v1/live/adb/action \
        -H "Content-Type: application/json" \
        -d "{\"boxIp\":\"${BOX_IP}\",\"action\":\"FORCE_STOP_PLAYER\"}" >/dev/null 2>&1 || true

      "${ADB_BIN}" connect "${BOX_IP}:5555" >/dev/null 2>&1 || true
      "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop com.android.chrome >/dev/null 2>&1 || true
      "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop de.ozerov.fully >/dev/null 2>&1 || true
      echo "   • Chrome e Fully Kiosk foram fechados na Box ${BOX_IP}."
      echo "   • A Box está agora no Desktop Android para poderes aceder às Definições ou Play Store à vontade!"
    fi
    echo "✅ Player parado e Watchdog desativado com sucesso!"
    ;;

  check|check-kiosk|status)
    if [[ -z "${BOX_IP}" ]]; then
      echo "Uso: $0 check <IP_DA_BOX>"
      exit 1
    fi
    echo "🔍 A verificar estado da Box ${BOX_IP}:5555..."
    "${ADB_BIN}" connect "${BOX_IP}:5555" >/dev/null 2>&1 || true

    if ! "${ADB_BIN}" devices | grep -q "${BOX_IP}:5555.*device"; then
      echo "❌ A Box ${BOX_IP}:5555 não está acessível via ADB. Verifica se está ligada e na mesma rede."
      exit 1
    fi

    echo "   • Ligação ADB: 🟢 ONLINE"
    BOOT="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')"
    echo "   • Arranque Android (boot_completed): ${BOOT}"

    FULLY_PATH="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell pm path de.ozerov.fully 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "${FULLY_PATH}" ]]; then
      echo "   • Fully Kiosk Browser: 🟢 INSTALADO (${FULLY_PATH})"
      HOME_ACT="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell cmd package get-home-activities 2>/dev/null | grep -i 'de.ozerov.fully' || echo '')"
      if [[ -n "${HOME_ACT}" ]]; then
        echo "   • Home Launcher Android: 🟢 CONFIGURADO (Arranque autónomo sem rede ativo)"
      else
        echo "   • Home Launcher Android: 🟡 NÃO DEFINIDO como padrão. Corre: $0 set-home ${BOX_IP}"
      fi
    else
      echo "   • Fully Kiosk Browser: 🔴 NÃO INSTALADO"
      echo "     💡 Dica: Abre a Google Play Store na Box e pesquisa 'Fully Kiosk Browser' -> Instalar"
    fi

    # Verifica o que está a correr no ecrã
    FOCUSED="$("${ADB_BIN}" -s "${BOX_IP}:5555" shell 'dumpsys activity activities | grep -iE "ResumedActivity|mFocusedApp" | head -n 2' 2>/dev/null || true)"
    echo "   • Janela em primeiro plano na TV:"
    echo "${FOCUSED}" | sed 's/^/     /'
    ;;

  set-home)
    if [[ -z "${BOX_IP}" ]]; then
      echo "Uso: $0 set-home <IP_DA_BOX>"
      exit 1
    fi
    echo "⚙️  A definir Fully Kiosk Browser como Home Launcher predefinido na Box ${BOX_IP}..."
    "${ADB_BIN}" connect "${BOX_IP}:5555" >/dev/null 2>&1 || true
    "${ADB_BIN}" -s "${BOX_IP}:5555" shell cmd package set-home-activity de.ozerov.fully/.MainActivity || true
    echo "✅ Concluído! A Box arrancará sempre no Fully Kiosk."
    ;;

  clear-tabs|reset-chrome)
    if [[ -z "${BOX_IP}" ]]; then
      echo "Uso: $0 clear-tabs <IP_DA_BOX>"
      exit 1
    fi
    echo "🧹 A eliminar 100% das abas acumuladas no Google Chrome da Box ${BOX_IP}..."
    "${ADB_BIN}" connect "${BOX_IP}:5555" >/dev/null 2>&1 || true
    # Força a paragem e faz reset total do pacote do Chrome (elimina todas as abas órfãs e restauradas)
    "${ADB_BIN}" -s "${BOX_IP}:5555" shell am force-stop com.android.chrome >/dev/null 2>&1 || true
    "${ADB_BIN}" -s "${BOX_IP}:5555" shell pm clear com.android.chrome >/dev/null 2>&1 || true
    echo "✅ Chrome limpo com sucesso! Nenhuma aba anterior restaura."
    ;;

  pause-watchdog)
    echo "⏸️  A pausar o Watchdog de supervisão..."
    if [[ -f "./data/storage/kiosk_watchdog.pid" ]]; then
      PID="$(cat ./data/storage/kiosk_watchdog.pid 2>/dev/null)"
      if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
        kill -9 "${PID}" 2>/dev/null || true
      fi
      rm -f ./data/storage/kiosk_watchdog.pid
    fi
    if [[ -n "${BOX_IP}" ]]; then
      curl -s -X POST http://127.0.0.1:3000/api/v1/live/adb/action \
        -H "Content-Type: application/json" \
        -d "{\"boxIp\":\"${BOX_IP}\",\"action\":\"TOGGLE_WATCHDOG\"}" >/dev/null 2>&1 || true
    fi
    echo "✅ Watchdog pausado."
    ;;

  resume|launch)
    PLAYER_URL="${3:-}"
    if [[ -z "${BOX_IP}" ]]; then
      echo "Uso: $0 resume <IP_DA_BOX> [PLAYER_URL]"
      exit 1
    fi
    echo "▶️  A relançar o Player na Box ${BOX_IP} e a reativar o Watchdog..."
    ./scripts/provision-x98-kiosk.sh "${BOX_IP}" "${PLAYER_URL}"
    ;;

  help|*)
    echo "==========================================================================="
    echo "🛡️  INVISION NEXUS — UTILITÁRIO DE CONTROLO DE KIOSK (BOX ANDROID X98 PLUS)"
    echo "==========================================================================="
    echo "Comandos disponíveis:"
    echo "  $0 stop [IP]          Pára o Player e pausa o Watchdog (para mexer na Box)"
    echo "  $0 check [IP]         Verifica se o Fully Kiosk está instalado e o estado"
    echo "  $0 clear-tabs [IP]    Elimina 100% das abas acumuladas no Google Chrome"
    echo "  $0 set-home [IP]      Define o Fully Kiosk como Home Launcher da Box"
    echo "  $0 resume [IP] [URL]  Relança o Player e reativa a supervisão automática"
    echo "==========================================================================="
    ;;
esac
