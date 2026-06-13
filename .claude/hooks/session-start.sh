#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install dependencies
bun install

# Register Quave ONE MCP if key is available
if [ -n "${QUAVE_MCP_KEY:-}" ]; then
  claude mcp remove quave-one --scope user 2>/dev/null || true
  claude mcp add --transport http --scope user quave-one https://mcp.quave.cloud/ \
    --header "authorization:${QUAVE_MCP_KEY}"
  echo "Quave ONE MCP registered."
else
  echo "Warning: QUAVE_MCP_KEY not set, skipping Quave ONE MCP registration."
fi
