#!/usr/bin/env bash
# Build and run a sandboxed pi bridge for TestFlight/App Store testing.
# Exposes only 127.0.0.1:${PI_BRIDGE_PUBLIC_PORT:-7171} on the host.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

if [[ ! -f .env.test ]]; then
  cp .env.test.example .env.test
  token="$(openssl rand -hex 32)"
  perl -0pi -e "s/replace-with-openssl-rand-hex-32/$token/" .env.test
  chmod 600 .env.test
  echo "Created server/.env.test with a fresh PI_BRIDGE_TOKEN."
fi

mkdir -p "${PI_TEST_WORKSPACE:-./test-workspace}"

compose=(docker compose -f docker-compose.test.yml)
"${compose[@]}" up --build -d

echo
echo "Sandbox bridge is running."
echo "Local URL: http://127.0.0.1:${PI_BRIDGE_PUBLIC_PORT:-7171}"
echo "Token    : $(grep '^PI_BRIDGE_TOKEN=' .env.test | sed 's/^PI_BRIDGE_TOKEN=//')"
echo
echo "Health check:"
curl -fsS "http://127.0.0.1:${PI_BRIDGE_PUBLIC_PORT:-7171}/health" || true
echo
echo
echo "To expose with Cloudflare Tunnel:"
echo "  cloudflared tunnel --url http://127.0.0.1:${PI_BRIDGE_PUBLIC_PORT:-7171}"
echo
echo "Logs:"
echo "  docker compose -f server/docker-compose.test.yml logs -f"
