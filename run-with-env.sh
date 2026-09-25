#!/bin/sh
# Compatibility entrypoint; keep environment resolution and stdio handling in
# the universal launcher, which works from any directory and preserves overrides.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/start-grok-mcp.sh" "$@"
