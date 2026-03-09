#!/usr/bin/env bash
set -euo pipefail

MODE="auto"
DRY_RUN="false"
REPO="."
FULL_COMMAND=""
UNIT_COMMAND=""

usage() {
  cat <<'EOF'
Usage: run-tests.sh [options]

Options:
  --mode <auto|full|unit>    Execution mode (default: auto)
  --dry-run                  Print decisions and command without running tests
  --repo <path>              Repository path (default: .)
  --full-command "<cmd>"     Override full test command
  --unit-command "<cmd>"     Override unit test command
  -h, --help                 Show this help

Exit codes:
  0 success
  1 test command failed
  2 blocked (missing required infrastructure or unsupported mode)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --full-command)
      FULL_COMMAND="${2:-}"
      shift 2
      ;;
    --unit-command)
      UNIT_COMMAND="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" != "auto" && "$MODE" != "full" && "$MODE" != "unit" ]]; then
  echo "Invalid --mode value: $MODE" >&2
  exit 2
fi

if [[ ! -d "$REPO" ]]; then
  echo "Repository path does not exist: $REPO" >&2
  exit 2
fi

cd "$REPO"

log() { echo "[bonaparte-test-runner] $*"; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

detect_pkg_manager() {
  if [[ -f pnpm-lock.yaml ]] && have_cmd pnpm; then
    echo "pnpm"
    return
  fi
  if [[ -f yarn.lock ]] && have_cmd yarn; then
    echo "yarn"
    return
  fi
  if [[ -f package-lock.json ]] && have_cmd npm; then
    echo "npm"
    return
  fi
  if have_cmd pnpm; then
    echo "pnpm"
    return
  fi
  if have_cmd npm; then
    echo "npm"
    return
  fi
  echo ""
}

PKG_MANAGER="$(detect_pkg_manager)"
if [[ -z "$PKG_MANAGER" ]]; then
  log "No supported package manager found (pnpm/npm/yarn)." >&2
  exit 2
fi

docker_ready="false"
if have_cmd docker && docker info >/dev/null 2>&1; then
  docker_ready="true"
fi

prisma_ready="false"
if have_cmd node; then
  if node -e "try { require('@prisma/client'); process.exit(0); } catch (_) { process.exit(1); }" >/dev/null 2>&1; then
    prisma_ready="true"
  fi
fi

global_setup_found="false"
if have_cmd rg; then
  if rg -n --glob '!node_modules/**' --glob '!*test-data/**' 'globalSetup' . >/dev/null 2>&1; then
    global_setup_found="true"
  fi
fi

default_full_command=""
default_unit_command=""
if [[ "$PKG_MANAGER" == "pnpm" ]]; then
  default_full_command="pnpm test"
elif [[ "$PKG_MANAGER" == "yarn" ]]; then
  default_full_command="yarn test"
else
  default_full_command="npm test"
fi

if [[ -z "$UNIT_COMMAND" ]] && [[ -f package.json ]] && have_cmd node; then
  unit_script="$(node -e "const fs=require('fs');try{const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const scripts=pkg.scripts||{};const keys=['test:unit','unit:test','test:fast','test:isolated'];for(const k of keys){if(scripts[k]){process.stdout.write(k);process.exit(0)}}process.exit(1)}catch(e){process.exit(1)}" 2>/dev/null || true)"
  if [[ -n "$unit_script" ]]; then
    if [[ "$PKG_MANAGER" == "pnpm" ]]; then
      default_unit_command="pnpm run $unit_script"
    elif [[ "$PKG_MANAGER" == "yarn" ]]; then
      default_unit_command="yarn $unit_script"
    else
      default_unit_command="npm run $unit_script"
    fi
  fi
fi

if [[ -z "$FULL_COMMAND" ]]; then
  FULL_COMMAND="$default_full_command"
fi
if [[ -z "$UNIT_COMMAND" ]]; then
  UNIT_COMMAND="$default_unit_command"
fi

selected_mode="$MODE"
reason=""

if [[ "$MODE" == "auto" ]]; then
  if [[ "$docker_ready" == "true" && "$prisma_ready" == "true" ]]; then
    selected_mode="full"
    reason="Docker and Prisma client are ready."
  elif [[ -n "$UNIT_COMMAND" ]]; then
    selected_mode="unit"
    reason="Full mode prerequisites missing; unit test script available."
  else
    selected_mode="blocked"
    reason="Full mode prerequisites missing and no unit test script detected."
  fi
elif [[ "$MODE" == "full" ]]; then
  if [[ "$docker_ready" != "true" || "$prisma_ready" != "true" ]]; then
    log "Forced full mode requested but prerequisites are missing." >&2
    log "docker_ready=$docker_ready prisma_ready=$prisma_ready" >&2
    exit 2
  fi
  reason="Forced full mode."
else
  if [[ -z "$UNIT_COMMAND" ]]; then
    log "Forced unit mode requested but no unit script found." >&2
    exit 2
  fi
  selected_mode="unit"
  reason="Forced unit mode."
fi

log "Preflight summary: docker_ready=$docker_ready prisma_ready=$prisma_ready global_setup_found=$global_setup_found"
log "Selected mode: $selected_mode"
log "Reason: $reason"

if [[ "$selected_mode" == "blocked" ]]; then
  log "Blocked: cannot run tests in this environment."
  if [[ "$docker_ready" != "true" ]]; then
    log "Missing Docker availability (command not found or daemon unavailable)."
  fi
  if [[ "$prisma_ready" != "true" ]]; then
    log "Missing generated Prisma client (@prisma/client import failed)."
  fi
  if [[ "$global_setup_found" == "true" ]]; then
    log "Vitest globalSetup detected; repository likely requires infra boot for default test command."
  fi
  log "Suggested remediation:"
  log "1) Install/start Docker."
  log "2) Generate Prisma client (for example: pnpm prisma generate)."
  log "3) Add a dedicated unit test script (e.g. test:unit) to bypass infra-heavy setup."
  exit 2
fi

cmd_to_run=""
if [[ "$selected_mode" == "full" ]]; then
  cmd_to_run="$FULL_COMMAND"
else
  cmd_to_run="$UNIT_COMMAND"
fi

log "Command: $cmd_to_run"
if [[ "$DRY_RUN" == "true" ]]; then
  log "Dry run enabled; command not executed."
  exit 0
fi

set +e
bash -lc "$cmd_to_run"
cmd_status=$?
set -e

if [[ $cmd_status -ne 0 ]]; then
  log "Test command failed with exit code $cmd_status."
  exit 1
fi

log "Test command succeeded."
