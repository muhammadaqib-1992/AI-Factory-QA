#!/usr/bin/env bash
# One-time setup on a Linux machine (Ubuntu/Debian tested in CI). Safe to re-run.
#
#   bash scripts/setup-linux.sh
#
# Installs the Node dependencies and Chromium (with the system libraries and fonts it needs),
# creates .env from the template, and prepares the local folders. It does not sign in to
# anything — run scripts/mcp-auth.sh for that afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }

say "Checking prerequisites"
command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org (or nvm / NodeSource)." >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js 20+ is required; found $(node -v)." >&2; exit 1; }
command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
echo "node $(node -v), npm $(npm -v)"
if [ "$(id -u)" -eq 0 ]; then
  echo "WARNING: running as root. Chromium refuses to start as root without --no-sandbox;"
  echo "         run the pipeline as a normal user (the setup itself may use sudo)."
fi
command -v claude >/dev/null && echo "claude $(claude --version 2>/dev/null | head -1)" \
  || echo "NOTE: Claude Code is not installed yet:  npm install -g @anthropic-ai/claude-code"

say "Installing Node dependencies"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

say "Installing Chromium and its system libraries"
if [ "$(id -u)" -eq 0 ]; then
  npx --no-install playwright install --with-deps chromium
elif command -v sudo >/dev/null; then
  sudo "$(command -v node)" node_modules/playwright/cli.js install-deps chromium
  npx --no-install playwright install chromium
else
  echo "No sudo: installing Chromium only. If it fails to start, ask an admin to run:"
  echo "  npx playwright install-deps chromium"
  npx --no-install playwright install chromium
fi

say "Preparing local folders and .env"
mkdir -p .auth logs state reports test-cases
chmod 700 .auth
[ -f .auth/netsuite-state.json ] || echo '{"cookies":[],"origins":[]}' > .auth/netsuite-state.json
chmod 600 .auth/netsuite-state.json
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example — fill it in:  nano .env"
else
  chmod 600 .env
  echo ".env already exists (left unchanged)."
fi
chmod +x scripts/*.sh

say "Done. Next steps"
cat <<'EOF'
  1. Fill in .env                         nano .env
  2. Sign in the MCP servers once         scripts/mcp-auth.sh jira | netsuite | gdrive
  3. Sign in to the NetSuite UI           node scripts/netsuite-login.mjs
  4. Check everything                     node scripts/check-setup.mjs
  5. Start Claude with the settings       scripts/with-env.sh claude
EOF
