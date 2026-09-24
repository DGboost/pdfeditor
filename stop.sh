#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
PID_FILE="$ROOT/.server.pid"

is_project_vite_server() {
  local pid="$1" args cwd
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  args="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$ROOT" && "$args" == *vite* && "$args" == *"--port $PORT"* ]]
}

stop_project_vite_server() {
  local pid="$1"
  if ! is_project_vite_server "$pid"; then return 1; fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..40}; do
    if ! is_project_vite_server "$pid"; then
      echo "Stopped project Vite server (PID $pid)."
      return 0
    fi
    sleep 0.25
  done
  if is_project_vite_server "$pid"; then
    echo "Vite PID $pid did not stop gracefully; sending SIGKILL." >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  for _ in {1..20}; do
    if ! is_project_vite_server "$pid"; then
      echo "Stopped project Vite server (PID $pid)."
      return 0
    fi
    sleep 0.25
  done
  echo "Could not stop project Vite server PID $pid." >&2
  return 1
}


declare -A PIDS=()
if [[ -f "$PID_FILE" ]]; then
  read -r PID < "$PID_FILE" || true
  if is_project_vite_server "${PID:-}"; then
    PIDS["$PID"]=1
  elif [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "PID file points to unrelated process $PID; leaving it running." >&2
  else
    echo "Removing stale server PID file."
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r PID; do
    [[ "$PID" =~ ^[0-9]+$ ]] || continue
    if is_project_vite_server "$PID"; then
      PIDS["$PID"]=1
    else
      echo "Leaving unrelated listener PID $PID on port $PORT untouched." >&2
    fi
  done < <(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u)
else
  echo "lsof unavailable; can only stop the PID recorded by start.sh." >&2
fi

if ((${#PIDS[@]} == 0)); then
  echo "No project Vite server running on port $PORT."
else
  for PID in "${!PIDS[@]}"; do stop_project_vite_server "$PID"; done
fi
