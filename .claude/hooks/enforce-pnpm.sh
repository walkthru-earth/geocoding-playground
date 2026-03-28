#!/bin/bash
# PreToolUse hook: Block npm/npx and suggest pnpm/pnpx equivalents.
# Exit 0 = allow, Exit 2 = block (sends stderr to Claude for self-correction).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Check if the command starts with npm or npx (not pnpm/pnpx)
if echo "$COMMAND" | grep -qE '^\s*(npm|npx)\b'; then
  # Extract what comes after npm/npx
  REPLACEMENT=$(echo "$COMMAND" | sed -E 's/^\s*npm\b/pnpm/; s/^\s*npx\b/pnpx/')
  echo "BLOCKED: This project uses pnpm. Use '$REPLACEMENT' instead of '$COMMAND'" >&2
  exit 2
fi

exit 0
