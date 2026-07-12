#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ -f .server.pid ]; then
  PID=$(cat .server.pid)
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "Server is already running (PID $PID). Run ./stop.sh first."
    exit 1
  fi
  rm -f .server.pid
fi

# Second line of defense: refuse to start if something is already bound to
# port 3000, even if .server.pid is missing/stale (e.g. process started
# outside this script). Without this, vite would silently drift to 3001,
# 3002, ... instead of failing, orphaning untracked servers.
PORT_PID=$(lsof -t -i:3000 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  echo "Port 3000 is already occupied (PID: $PORT_PID). Run ./stop.sh first."
  exit 1
fi

# Install dependencies if node_modules is missing
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Build the project for production
echo "Building the project..."
npm run build

# Start the preview server in background
echo "Starting server..."
npx vite preview --port 3000 --strictPort --host > server.log 2>&1 &
echo $! > .server.pid

# Wait a moment and verify the process is alive
sleep 2
PID=$(cat .server.pid)
if ! ps -p "$PID" > /dev/null 2>&1; then
  echo "Server failed to start. Check server.log for details."
  rm -f .server.pid
  exit 1
fi

echo "Server started (PID $PID). Access the app at http://localhost:3000"
echo "Logs: server.log | Stop: ./stop.sh"
