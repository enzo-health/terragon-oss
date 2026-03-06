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

# Sandbox exposes 48+ host CPUs but only has 8GB RAM.
# Cap Node.js heap and test runner workers to prevent OOM SIGKILL.
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--max-old-space-size=4096"
export VITEST_MAX_WORKERS=4
export JEST_WORKER_COUNT=4
export UV_THREADPOOL_SIZE=4
export TURBO_CONCURRENCY=4
export NX_MAX_PARALLEL=4
# tsgo (Go-based tsc) ignores NODE_OPTIONS — use Go runtime vars instead
export GOMEMLIMIT=6GiB
export GOMAXPROCS=4

# Install deps if missing
if [ ! -d node_modules ]; then
  INSTALL_OUTPUT=$($PM install 2>&1)
  if [ $? -ne 0 ]; then
    QC_OUTPUT="$INSTALL_OUTPUT" node -e '
      const o = process.env.QC_OUTPUT || "";
      const t = o.length > 2000 ? o.slice(0,2000) + "... (truncated)" : o;
      process.stdout.write(JSON.stringify({decision:"block",reason:"Dependency install failed:\\n"+t}));
    '
    exit 0
  fi
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

# Group 1: Lint (non-mutating only — no lint:fix)
for script in lint; do
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
  QC_ERRORS="$errors" node -e '
    const errors = (process.env.QC_ERRORS || "").replace(/\\n/g, " ");
    const t = errors.length > 2000 ? errors.slice(0,2000) + "... (truncated)" : errors;
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: "Quality checks failed. Fix the errors before completing:\\n" + t
    }));
  '
  exit 0
fi

# All checks passed — reset attempt counter
rm -f "$ATTEMPT_FILE"
exit 0
`;
}
