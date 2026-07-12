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
else
  # Fallback: check if port 3000 is occupied
  PORT_PID=$(lsof -t -i:3000 2>/dev/null)
  if [ -n "$PORT_PID" ]; then
    kill "$PORT_PID"
    echo "Stopped server running on port 3000 (PID: $PORT_PID)."
  else
    echo "No server running on port 3000."
  fi
fi
