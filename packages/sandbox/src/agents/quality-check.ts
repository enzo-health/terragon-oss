/**
 * Builds a shell script that runs quality checks (lint, typecheck, test)
 * before allowing an agent to stop. Used as a Claude Code Stop hook.
 *
 * The script:
 * - Skips non-JS/TS projects (no package.json)
 * - Detects package manager from lockfiles
 * - Installs deps if node_modules is missing
 * - Runs lint, typecheck, test scripts auto-detected from package.json
 * - Blocks the agent with structured JSON if any check fails
 * - Prevents infinite retry loops via attempt counter
 */
export function buildQualityCheckScript(): string {
  return `#!/bin/bash
set -o pipefail

# --- Quality check Stop hook for Terragon SDLC ---

# Skip if no package.json (not a JS/TS project)
if [ ! -f package.json ]; then
  exit 0
fi

# Attempt counter to prevent infinite retry loops
ATTEMPT_FILE="/tmp/terragon-qc-attempts"
MAX_ATTEMPTS=3

if [ -f "$ATTEMPT_FILE" ]; then
  ATTEMPTS=$(cat "$ATTEMPT_FILE" 2>/dev/null || echo "0")
else
  ATTEMPTS=0
fi

ATTEMPTS=$((ATTEMPTS + 1))
echo "$ATTEMPTS" > "$ATTEMPT_FILE"

if [ "$ATTEMPTS" -gt "$MAX_ATTEMPTS" ]; then
  # Reset counter and let the agent stop to avoid infinite loops
  rm -f "$ATTEMPT_FILE"
  exit 0
fi

# Detect package manager
detect_pm() {
  if [ -f pnpm-lock.yaml ]; then echo "pnpm"
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then echo "bun"
  elif [ -f yarn.lock ]; then echo "yarn"
  else echo "npm"
  fi
}

PM=$(detect_pm)

# Install deps if missing
if [ ! -d node_modules ]; then
  $PM install 2>&1 || true
fi

# Check if a script exists in package.json
has_script() {
  node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['$1'] ? 0 : 1)" 2>/dev/null
}

# Truncate output to avoid massive JSON payloads
truncate_output() {
  local max_chars=2000
  local input="$1"
  if [ \${#input} -gt $max_chars ]; then
    echo "\${input:0:$max_chars}... (truncated)"
  else
    echo "$input"
  fi
}

errors=""

# Group 1: Lint (run first matching)
for script in lint lint:fix; do
  if has_script "$script"; then
    output=$($PM run "$script" 2>&1)
    if [ $? -ne 0 ]; then
      truncated=$(truncate_output "$output")
      errors+="$PM run $script failed:\\n$truncated\\n\\n"
    fi
    break
  fi
done

# Group 2: Typecheck (run first matching)
for script in typecheck type-check tsc; do
  if has_script "$script"; then
    output=$($PM run "$script" 2>&1)
    if [ $? -ne 0 ]; then
      truncated=$(truncate_output "$output")
      errors+="$PM run $script failed:\\n$truncated\\n\\n"
    fi
    break
  fi
done

# Group 3: Test (run first matching)
for script in test; do
  if has_script "$script"; then
    output=$($PM run "$script" 2>&1)
    if [ $? -ne 0 ]; then
      truncated=$(truncate_output "$output")
      errors+="$PM run $script failed:\\n$truncated\\n\\n"
    fi
    break
  fi
done

if [ -n "$errors" ]; then
  # Escape for JSON: replace backslashes, quotes, newlines
  escaped_errors=$(echo -e "$errors" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
  printf '{"decision":"block","reason":"Quality checks failed. Fix the errors before completing:\\n%s"}' "$escaped_errors"
  exit 0
fi

# All checks passed — reset attempt counter
rm -f "$ATTEMPT_FILE"
exit 0
`;
}
