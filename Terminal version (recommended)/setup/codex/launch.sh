#!/bin/bash
set -euo pipefail

CONTENTS="$(cd "$(dirname "$0")/.." && pwd -P)"
RESOURCES="$CONTENTS/Resources"
NODE="$CONTENTS/Frameworks/node/bin/node"
NODE_BIN="$(dirname "$NODE")"
RUNTIME_BIN="$RESOURCES/runtime/bin"

if [ ! -x "$NODE" ] || [ ! -x "$RUNTIME_BIN/rg" ]; then
  echo 'DataBrain MCP bundle is incomplete: its pinned local runtime is missing.' >&2
  exit 78
fi

export DATABRAIN_NODE_BIN="$NODE_BIN"
export DATABRAIN_RUNTIME_BIN="$RUNTIME_BIN"
export PATH="$NODE_BIN:$RUNTIME_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$NODE" "$RESOURCES/setup/mcp/server.mjs" --databrain-client codex
