#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT=3000
HOST="${HOST:-127.0.0.1}"
PID_FILE="$ROOT/.server.pid"
LOG_FILE="$ROOT/server.log"

BUILD_MODE=build
case "${1:-}" in
  "") ;;
  --reuse-build) BUILD_MODE=reuse ;;
  *)
    echo "Usage: ./start.sh [--reuse-build]" >&2
    exit 2
    ;;
esac

is_project_preview() {
  local pid="$1" args cwd
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  args="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$ROOT" && "$args" == *vite*preview* && "$args" == *"--port $PORT"* ]]
}

if ! command -v lsof >/dev/null 2>&1; then
  echo "Required command not found: lsof. Install lsof before starting the server." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  read -r PID < "$PID_FILE" || true
  if is_project_preview "${PID:-}"; then
    echo "Server is already running (PID $PID). Run ./stop.sh first." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

mapfile -t PORT_PIDS < <(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u)
if ((${#PORT_PIDS[@]})); then
  printf 'Port %s is already occupied (PID: %s). Refusing to stop an existing service.\n' \
    "$PORT" "${PORT_PIDS[*]}" >&2
  exit 1
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "Installing dependencies..."
  npm install
fi

if [[ "$BUILD_MODE" == "reuse" ]]; then
  for artifact in dist/index.html public/engines/docx/index.html public/engines/rhwp/index.html public/engines/pptx/index.html; do
    if [[ ! -f "$ROOT/$artifact" ]]; then
      echo "Missing build output: $artifact. Run ./start.sh to build first." >&2
      exit 1
    fi
  done
  echo "Reusing existing build output (source changes will not be included)."
else
  echo "Building the project..."
  npm run build
fi

echo "Starting preview on http://$HOST:$PORT ..."
"$ROOT/node_modules/.bin/vite" preview --host "$HOST" --port "$PORT" --strictPort > "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

READY=0
for _ in {1..40}; do
  if ! is_project_preview "$PID"; then
    break
  fi
  if node -e 'const http=require("node:http");const r=http.get("http://127.0.0.1:3000/",s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(1000,()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))'; then
    READY=1
    break
  fi
  sleep 0.25
done

if ((READY == 0)); then
  echo "Server failed to become ready. Check $LOG_FILE." >&2
  if is_project_preview "$PID"; then kill -TERM "$PID" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  exit 1
fi

echo "Server started (PID $PID). Access the app at http://127.0.0.1:$PORT"
echo "Logs: server.log | Stop: ./stop.sh"
