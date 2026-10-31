#!/bin/bash
# Claude Code on the web only: install deps and register the Quave ONE MCP.
# QUAVE_MCP_KEY comes from the web environment settings; never commit it.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# Install dependencies from the lockfile without rewriting it. A failure here
# should not prevent the MCP registration below.
bun install --frozen-lockfile || echo "Warning: bun install failed." >&2

# Register Quave ONE MCP (production: the app is deployed there) if key is set.
if [ -n "${QUAVE_MCP_KEY:-}" ] && command -v claude >/dev/null 2>&1; then
  claude mcp remove quave-one --scope user >/dev/null 2>&1 || true
  claude mcp add --transport http --scope user quave-one https://mcp.quave.cloud/ \
    --header "authorization:${QUAVE_MCP_KEY}" >/dev/null
  echo "Quave ONE MCP registered."
else
  echo "Warning: QUAVE_MCP_KEY or claude CLI missing, skipping Quave ONE MCP registration." >&2
fi
