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
npx vite preview --port 3000 --host > server.log 2>&1 &
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
