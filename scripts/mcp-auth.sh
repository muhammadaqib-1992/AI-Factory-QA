#!/usr/bin/env bash
# One-time OAuth sign-in for the MCP servers that need one, on a headless Linux machine.
#
#   scripts/mcp-auth.sh jira        Atlassian (mcp-remote)  callback port JIRA_MCP_CALLBACK_PORT (3334)
#   scripts/mcp-auth.sh netsuite    NetSuite AI Connector   callback port NETSUITE_OAUTH_CALLBACK_PORT (8080)
#   scripts/mcp-auth.sh gdrive      Google Drive            see the note printed below
#
# The server has no browser, so sign in from your laptop through an SSH tunnel:
#   1. On the laptop:   ssh -L 3334:127.0.0.1:3334 -L 8080:127.0.0.1:8080 <user>@<server>
#   2. In that session: scripts/mcp-auth.sh jira   (or netsuite)
#   3. Open the URL it prints in the laptop's browser and sign in. The redirect to
#      http://localhost:<port>/callback travels back through the tunnel to the server.
# Tokens are cached on the server and refresh automatically; repeat only if they expire.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

case "${1:-}" in
  jira)
    port="${JIRA_MCP_CALLBACK_PORT:-3334}"
    echo "Signing in to Atlassian. Callback: http://localhost:${port} (keep the SSH tunnel for port ${port} open)."
    echo "Open the URL printed below in your laptop's browser. The command exits once it has listed the tools."
    npx --no-install mcp-remote-client https://mcp.atlassian.com/v1/mcp "$port"
    ;;
  netsuite)
    echo "Signing in to NetSuite. Callback: http://localhost:${NETSUITE_OAUTH_CALLBACK_PORT:-8080}/callback"
    echo "Open the URL printed below in your laptop's browser, log in, and pick the MCP role."
    node scripts/netsuite-mcp-auth.mjs
    ;;
  gdrive)
    : "${GDRIVE_OAUTH_PATH:?set GDRIVE_OAUTH_PATH in .env}"
    : "${GDRIVE_CREDENTIALS_PATH:?set GDRIVE_CREDENTIALS_PATH in .env}"
    mkdir -p "$(dirname "$GDRIVE_CREDENTIALS_PATH")"
    cat <<EOF
Google Drive's sign-in listens on a random local port, which is awkward to tunnel.
Easiest: run the sign-in on your laptop, then copy the token file to this server:

  laptop$  GDRIVE_OAUTH_PATH=./gdrive-credentials.json GDRIVE_CREDENTIALS_PATH=./gdrive-token.json \\
             npx -y @modelcontextprotocol/server-gdrive@2025.1.14 auth
  laptop$  scp gdrive-credentials.json gdrive-token.json <user>@<server>:$(dirname "$GDRIVE_CREDENTIALS_PATH")/

Trying the sign-in here anyway (it prints a URL; tunnel the port it shows if you go this way)...
EOF
    npx -y @modelcontextprotocol/server-gdrive@2025.1.14 auth
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
