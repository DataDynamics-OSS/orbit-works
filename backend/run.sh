#!/usr/bin/env bash
# Run the Orbit backend (FastAPI + uvicorn) in the foreground.
#
# Usage:
#   ./run.sh                       # foreground uvicorn on 0.0.0.0:4001
#   ./run.sh --reload              # with auto-reload (dev)
#   HOST=127.0.0.1 PORT=5001 ./run.sh
#   ORBIT_CONFIG_FILE=/etc/orbit.yaml ./run.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default config.yaml lives at the project root (one level up from backend/)
# 기존 DLM_CONFIG_FILE 이 설정돼 있으면 그것을 우선 사용 (하위호환).
export ORBIT_CONFIG_FILE="${ORBIT_CONFIG_FILE:-${DLM_CONFIG_FILE:-$SCRIPT_DIR/../config.yaml}}"

# Activate a local Python venv if one exists and none is active yet.
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  if [[ -f "$SCRIPT_DIR/.venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.venv/bin/activate"
  elif [[ -f "$SCRIPT_DIR/venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/venv/bin/activate"
  fi
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-4001}"

echo "Starting Orbit backend in foreground"
echo "  URL:    http://${HOST}:${PORT}"
echo "  Docs:   http://${HOST}:${PORT}/docs"
echo "  Config: ${ORBIT_CONFIG_FILE}"
echo

export DATABASE__HOST="${DATABASE__HOST:-localhost}"

# --reload-dir app: watchfiles 가 backend/app/ 만 watch.
#   기본 동작은 cwd 전체를 watch 하므로 logs/app.log (매 요청 쓰기) · data/
#   업로드 · __pycache__ 등이 reload 를 무한 트리거 → 매 request 시 worker
#   가 중단·재기동되어 5xx 가능. 디렉터리 한정으로 차단.
exec uvicorn app.main:app --host "$HOST" --port "$PORT" \
    --reload --reload-dir app "$@"
