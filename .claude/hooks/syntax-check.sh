#!/bin/bash
# PostToolUse: runs node --check on src/server.js after any Edit/Write to that file.
# Claude Code passes the tool input as JSON on stdin.
FILE=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)
[[ "$FILE" == *"server.js"* ]] || exit 0
if node --check "$FILE" 2>&1; then
  echo "✓ $(basename "$FILE") syntax OK"
else
  echo "✗ SYNTAX ERROR in $(basename "$FILE") — fix before pushing"
  exit 1
fi
