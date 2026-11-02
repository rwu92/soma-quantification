#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to start the local test server."
  echo "Install Python 3, then run this file again."
  read -r -p "Press Return to close..."
  exit 1
fi

# Prefer 8000, but automatically choose the next open local port if another
# application is already using it. This keeps double-click testing reliable.
PORT="$(python3 - <<'PY'
import socket
for port in range(8000, 8021):
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', port))
    except OSError:
        s.close()
        continue
    s.close()
    print(port)
    break
else:
    raise SystemExit('No free local port found between 8000 and 8020.')
PY
)"

if command -v open >/dev/null 2>&1; then
  (sleep 1; open "http://localhost:${PORT}" >/dev/null 2>&1 || true) &
fi

echo "Soma Quantification: http://localhost:${PORT}"
echo "Keep this window open while testing. Press Control-C to stop the server."
echo
exec python3 serve.py "$PORT"
