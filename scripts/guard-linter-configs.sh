#!/bin/bash
# Quality-gate configs must not be loosened casually: modifying one fails here
# so the change becomes a conscious act (review, then --no-verify). Introducing
# a config for the first time is allowed — the guard protects the ratchet, not
# the bootstrap.
blocked=0
for file in "$@"; do
  if git diff --cached --diff-filter=M --name-only | grep -qx "$file"; then
    echo "Guarded quality-gate config modified: $file" >&2
    blocked=1
  fi
done

if [ "$blocked" -eq 1 ]; then
  echo "If the change is intentional (e.g. raising a threshold), review it and commit with --no-verify." >&2
fi

exit "$blocked"
