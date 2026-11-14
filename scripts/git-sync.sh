#!/usr/bin/env bash
# ============================================================================
# INVISION NEXUS (FNAC & DARTY) - SINCRONIZAÇÃO CONTÍNUA COM GITHUB
# Uso no Mac: bash scripts/git-sync.sh ["Mensagem do commit opcional"]
# ============================================================================

set -euo pipefail

COMMIT_MSG="${1:-chore: atualização contínua do desenvolvimento Invision Nexus ($(date '+%Y-%m-%d %H:%M'))}"

echo "==> [1/3] A verificar alterações no projeto Invision Nexus..."
git add -A

if git diff --cached --quiet; then
  echo "ℹ️  Nenhuma alteração pendente para commit."
else
  echo "==> [2/3] A criar commit: '${COMMIT_MSG}'..."
  git commit -m "${COMMIT_MSG}"
fi

CURRENT_BRANCH="$(git branch --show-current || echo 'main')"
echo "==> [3/3] A enviar atualizações para o GitHub (origin/${CURRENT_BRANCH})..."
git push -u origin "${CURRENT_BRANCH}"

echo "✅ Repositório GitHub atualizado com sucesso!"
echo "   Para atualizar agora o teu Synology NAS, corre no NAS:"
echo "   bash scripts/update-nas.sh"
