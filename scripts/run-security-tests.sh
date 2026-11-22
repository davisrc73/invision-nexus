#!/usr/bin/env bash
# ==============================================================================
# Invision Nexus — Execução Automatizada da Suíte de Cibersegurança & Hardening
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

API_TARGET="${1:-http://127.0.0.1:3000}"

echo "Iniciando auditoria de segurança contra: $API_TARGET"
node tests/security-suite.mjs "$API_TARGET"
