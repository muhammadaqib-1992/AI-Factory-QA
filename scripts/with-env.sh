#!/usr/bin/env bash
# Exports the repo's .env, then runs the given command from the repo root.
# .mcp.json reads its settings as ${VAR}, so Claude must be started this way:
#
#   scripts/with-env.sh claude
#   scripts/with-env.sh claude mcp list
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

exec "$@"
