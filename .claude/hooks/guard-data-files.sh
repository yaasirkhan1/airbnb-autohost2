#!/bin/bash
# PreToolUse: blocks edits to UUID source-of-truth data files with a clear warning.
# Exit 2 = block the tool call and show this message to the user.
FILE=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)
if [[ "$FILE" == *"unit-profiles.json"* ]] || [[ "$FILE" == *"properties-map.json"* ]]; then
  echo "⚠️  PROTECTED FILE: $(basename "$FILE")"
  echo ""
  echo "This file is the UUID source-of-truth for all 7 Atlanta properties."
  echo "A wrong UUID here silently breaks the auto-responder for that property."
  echo ""
  echo "Confirm this edit is intentional — wrong UUIDs have caused issues before."
  exit 2
fi
