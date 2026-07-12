#!/bin/bash
cd "$(dirname "$0")"

if [ -f .server.pid ]; then
  PID=$(cat .server.pid)
  if ps -p "$PID" > /dev/null 2>&1; then
    kill "$PID"
    echo "Stopped server with PID $PID."
  else
    echo "Server process $PID was not running, cleaning up PID file."
  fi
  rm -f .server.pid
fi

# Always sweep port 3000 too, in case a process is bound there without a
# matching PID file (e.g. started outside this script).
PORT_PIDS=$(lsof -t -i:3000 2>/dev/null)
if [ -n "$PORT_PIDS" ]; then
  echo "$PORT_PIDS" | xargs -r kill
  echo "Stopped stray server(s) on port 3000 (PID: $(echo $PORT_PIDS | tr '\n' ' '))."
fi

# Sweep any vite preview instances for this project that drifted to a
# fallback port (pre-existing bug: previously started without --strictPort).
STRAY_PIDS=$(pgrep -f "pdfeditor/node_modules/\.bin/vite preview" 2>/dev/null)
if [ -n "$STRAY_PIDS" ]; then
  echo "$STRAY_PIDS" | xargs -r kill
  echo "Stopped stray preview process(es) (PID: $(echo $STRAY_PIDS | tr '\n' ' '))."
fi

if [ -z "$PORT_PIDS" ] && [ -z "$STRAY_PIDS" ] && [ ! -f .server.pid ]; then
  echo "No server running."
fi
