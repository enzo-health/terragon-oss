#!/usr/bin/env bash
# Terragon Mac Mini Worker Setup Script
# Served from GET /api/mac-mini-setup.sh
# Run on Mac Minis to set them up as Terragon sandbox workers.
#
# Usage:
#   curl -fsSL https://your-terragon-app/api/mac-mini-setup.sh | bash
#   bash setup.sh --uninstall

set -e

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
print_header() {
  echo ""
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════${RESET}"
}

print_step() {
  echo -e "${BLUE}▶${RESET} $1"
}

print_ok() {
  echo -e "${GREEN}✔${RESET} $1"
}

print_warn() {
  echo -e "${YELLOW}⚠${RESET} $1"
}

print_error() {
  echo -e "${RED}✘${RESET} $1"
}

# ---------------------------------------------------------------------------
# Error trap
# ---------------------------------------------------------------------------
on_error() {
  echo ""
  print_error "Setup failed at line ${BASH_LINENO[0]}."
  echo ""
  echo -e "  ${YELLOW}Tips:${RESET}"
  echo "    • Re-run the script once any indicated issue is resolved."
  echo "    • For help, visit https://terragon.ai/docs/mac-mini-workers"
  echo ""
  exit 1
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Uninstall mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--uninstall" ]]; then
  print_header "Terragon Worker Uninstall"

  PLIST_PATH="$HOME/Library/LaunchAgents/com.terragon.worker.plist"
  WORKER_DIR="$HOME/.terragon-worker"

  print_step "Stopping launchd service..."
  if launchctl list | grep -q "com.terragon.worker" 2>/dev/null; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    print_ok "Service stopped and unloaded."
  else
    print_warn "Service was not loaded; skipping."
  fi

  if [[ -f "$PLIST_PATH" ]]; then
    rm -f "$PLIST_PATH"
    print_ok "Removed plist: $PLIST_PATH"
  fi

  if [[ -d "$WORKER_DIR" ]]; then
    rm -rf "$WORKER_DIR"
    print_ok "Removed worker directory: $WORKER_DIR"
  fi

  echo ""
  read -r -p "$(echo -e "${YELLOW}Uninstall opensandbox-server via ${PYTHON_BIN} -m pip? [y/N]: ${RESET}")" UNINSTALL_PIP
  if [[ "${UNINSTALL_PIP,,}" == "y" ]]; then
    "$PYTHON_BIN" -m pip uninstall -y opensandbox-server && print_ok "opensandbox-server uninstalled." || print_warn "opensandbox-server uninstall failed (may not have been installed)."
  fi

  echo ""
  print_ok "Uninstall complete."
  exit 0
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ████████╗███████╗██████╗ ██████╗  █████╗  ██████╗  ██████╗ ███╗   ██╗"
echo "     ██╔══╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔═══██╗████╗  ██║"
echo "     ██║   █████╗  ██████╔╝██████╔╝███████║██║  ███╗██║   ██║██╔██╗ ██║"
echo "     ██║   ██╔══╝  ██╔══██╗██╔══██╗██╔══██║██║   ██║██║   ██║██║╚██╗██║"
echo "     ██║   ███████╗██║  ██║██║  ██║██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║"
echo "     ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝"
echo -e "${RESET}"
echo -e "  ${BOLD}Mac Mini Sandbox Worker Setup${RESET}"
echo ""

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
print_header "1 / 8  Checking Prerequisites"

# macOS check
if [[ "$(uname -s)" != "Darwin" ]]; then
  print_error "This script must be run on macOS."
  exit 1
fi
print_ok "Running on macOS $(sw_vers -productVersion)"

# Disk space check (>= 20 GB free)
print_step "Checking available disk space..."
AVAIL_BYTES=$(df -k / | awk 'NR==2 {print $4}')
AVAIL_GB=$(( AVAIL_BYTES / 1048576 ))
if (( AVAIL_GB < 20 )); then
  print_error "Only ${AVAIL_GB} GB free on /. At least 20 GB is required."
  exit 1
fi
print_ok "Disk space OK: ${AVAIL_GB} GB free"

# Python 3.10+ check
print_step "Checking Python version..."
PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" &>/dev/null; then
    PY_VER=$("$candidate" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if (( PY_MAJOR > 3 )) || { (( PY_MAJOR == 3 )) && (( PY_MINOR >= 10 )); }; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  print_error "Python 3.10 or newer is required but was not found."
  echo "  Install it from https://www.python.org/downloads/ or via Homebrew:"
  echo "    brew install python@3.12"
  exit 1
fi
print_ok "Python OK: $($PYTHON_BIN --version)"
PYTHON_BIN=$(command -v "$PYTHON_BIN")

# ---------------------------------------------------------------------------
# 2. Homebrew
# ---------------------------------------------------------------------------
print_header "2 / 8  Homebrew"

if command -v brew &>/dev/null; then
  print_ok "Homebrew already installed: $(brew --version | head -1)"
else
  print_step "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  print_ok "Homebrew installed."
fi

# ---------------------------------------------------------------------------
# 3. Tailscale
# ---------------------------------------------------------------------------
print_header "3 / 8  Tailscale"

if command -v tailscale &>/dev/null; then
  print_ok "Tailscale already installed."
else
  print_step "Installing Tailscale via Homebrew..."
  brew install tailscale
  print_ok "Tailscale installed."
fi

# Check if already connected to a tailnet
TAILSCALE_IP=""
if tailscale ip -4 &>/dev/null 2>&1; then
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
fi

if [[ -n "$TAILSCALE_IP" ]]; then
  print_ok "Already connected to Tailscale tailnet (IP: ${TAILSCALE_IP})"
else
  echo ""
  echo -e "${YELLOW}Action required:${RESET} Tailscale needs to join your tailnet."
  echo ""
  echo "  Run the following command in a separate terminal window:"
  echo ""
  echo -e "    ${BOLD}sudo tailscale up${RESET}"
  echo ""
  echo "  Then authenticate in your browser and return here."
  echo ""
  read -r -p "$(echo -e "${CYAN}Press Enter once you have joined the tailnet...${RESET}")"

  # Retry fetching the IP after user confirms
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
  if [[ -z "$TAILSCALE_IP" ]]; then
    print_error "Could not retrieve Tailscale IP. Make sure 'sudo tailscale up' completed successfully."
    exit 1
  fi
  print_ok "Connected to Tailscale tailnet (IP: ${TAILSCALE_IP})"
fi

# ---------------------------------------------------------------------------
# 4. OrbStack / Docker Desktop
# ---------------------------------------------------------------------------
print_header "4 / 8  Container Runtime (OrbStack or Docker Desktop)"

DOCKER_READY=false

# Check if Docker daemon is already reachable (works for both OrbStack and Docker Desktop)
if docker info &>/dev/null 2>&1; then
  RUNTIME_NAME="unknown"
  if command -v orb &>/dev/null; then
    RUNTIME_NAME="OrbStack"
  elif [[ -d "/Applications/Docker.app" ]]; then
    RUNTIME_NAME="Docker Desktop"
  fi
  print_ok "Docker daemon already running ($RUNTIME_NAME)."
  DOCKER_READY=true
fi

if ! $DOCKER_READY; then
  # Prefer OrbStack
  if command -v orb &>/dev/null || [[ -d "/Applications/OrbStack.app" ]]; then
    print_ok "OrbStack is installed. Attempting to start it..."
    open -a OrbStack 2>/dev/null || true
    print_step "Waiting for Docker daemon to become available (up to 60s)..."
    for i in $(seq 1 12); do
      sleep 5
      if docker info &>/dev/null 2>&1; then
        print_ok "OrbStack Docker daemon is ready."
        DOCKER_READY=true
        break
      fi
      echo "  ... still waiting (${i}/12)"
    done
  elif brew list --cask orbstack &>/dev/null 2>&1; then
    print_ok "OrbStack already installed via Homebrew Cask."
    DOCKER_READY=true
  else
    print_step "Installing OrbStack via Homebrew Cask (preferred over Docker Desktop)..."
    brew install --cask orbstack
    print_step "Starting OrbStack..."
    open -a OrbStack 2>/dev/null || true
    print_step "Waiting for Docker daemon to become available (up to 90s)..."
    for i in $(seq 1 18); do
      sleep 5
      if docker info &>/dev/null 2>&1; then
        print_ok "OrbStack Docker daemon is ready."
        DOCKER_READY=true
        break
      fi
      echo "  ... still waiting (${i}/18)"
    done
  fi
fi

if ! $DOCKER_READY; then
  # Fallback: check for Docker Desktop
  if [[ -d "/Applications/Docker.app" ]]; then
    print_warn "OrbStack not ready; found Docker Desktop — attempting to start it..."
    open -a Docker 2>/dev/null || true
    print_step "Waiting for Docker daemon (up to 90s)..."
    for i in $(seq 1 18); do
      sleep 5
      if docker info &>/dev/null 2>&1; then
        print_ok "Docker Desktop daemon is ready."
        DOCKER_READY=true
        break
      fi
      echo "  ... still waiting (${i}/18)"
    done
  fi
fi

if ! $DOCKER_READY; then
  print_error "Docker daemon is not running. Please start OrbStack or Docker Desktop and re-run this script."
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. opensandbox-server
# ---------------------------------------------------------------------------
print_header "5 / 8  OpenSandbox Server"

print_step "Installing opensandbox-server into the user site via ${PYTHON_BIN} -m pip..."
"$PYTHON_BIN" -m pip install --user --break-system-packages --upgrade opensandbox-server
print_ok "opensandbox-server installed."

# ---------------------------------------------------------------------------
# 6. Pull Terragon sandbox Docker image
# ---------------------------------------------------------------------------
print_header "6 / 8  Pulling Terragon Sandbox Docker Image"

# NOTE: The image name below may differ depending on your Terragon deployment.
# Update TERRAGON_IMAGE if you are using a custom registry or image tag.
TERRAGON_IMAGE="ghcr.io/terragon-labs/containers-test:latest"

print_step "Pulling ${TERRAGON_IMAGE} ..."
docker pull "$TERRAGON_IMAGE"
print_ok "Image pulled successfully."

# ---------------------------------------------------------------------------
# 7. Configuration
# ---------------------------------------------------------------------------
print_header "7 / 8  Generating Configuration"

# 7a. Generate API key
print_step "Generating random API key..."
GENERATED_API_KEY=$(openssl rand -hex 32)
print_ok "API key generated."

# 7b. Get Tailscale IP (already fetched above, but refresh in case of reconnect)
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
if [[ -z "$TAILSCALE_IP" ]]; then
  print_error "Could not determine Tailscale IP. Please ensure Tailscale is connected."
  exit 1
fi
print_ok "Tailscale IP: ${TAILSCALE_IP}"

# 7c. Worker name
DEFAULT_HOSTNAME=$(hostname -s 2>/dev/null || echo "mac-mini-01")
echo ""
read -r -p "$(echo -e "${CYAN}Enter a name for this worker [${DEFAULT_HOSTNAME}]: ${RESET}")" WORKER_NAME
WORKER_NAME="${WORKER_NAME:-$DEFAULT_HOSTNAME}"
print_ok "Worker name: ${WORKER_NAME}"

# 7d. System info
OS_VERSION=$(sw_vers -productVersion)
CPU_CORES=$(sysctl -n hw.logicalcpu)
MEM_BYTES=$(sysctl -n hw.memsize)
MEMORY_GB=$(( MEM_BYTES / 1073741824 ))

# 7e. Write OpenSandbox config
WORKER_DIR="$HOME/.terragon-worker"
OPENSANDBOX_CONFIG="$WORKER_DIR/opensandbox.toml"
mkdir -p "$WORKER_DIR"

cat > "$OPENSANDBOX_CONFIG" <<TOML
[server]
host = "0.0.0.0"
port = 8080
api_key = "${GENERATED_API_KEY}"

[runtime]
type = "docker"
# NOTE: Update default_image if you are using a different registry or tag.
default_image = "${TERRAGON_IMAGE}"

[resources]
max_sandboxes = 1
TOML

print_ok "Config written to: ${OPENSANDBOX_CONFIG}"

# ---------------------------------------------------------------------------
# 8. launchd service
# ---------------------------------------------------------------------------
print_header "8 / 8  Installing launchd Service"

PLIST_PATH="$HOME/Library/LaunchAgents/com.terragon.worker.plist"
mkdir -p "$HOME/Library/LaunchAgents"

# Find the opensandbox-server binary
OPENSANDBOX_BIN=$(command -v opensandbox-server 2>/dev/null || true)
if [[ -z "$OPENSANDBOX_BIN" ]]; then
  PYTHON_USER_BASE=$("$PYTHON_BIN" -m site --user-base 2>/dev/null || true)
  # Try common pip install locations
  for candidate in \
    "${PYTHON_USER_BASE}/bin/opensandbox-server" \
    "$HOME/Library/Python/3.13/bin/opensandbox-server" \
    "$HOME/Library/Python/3.12/bin/opensandbox-server" \
    "$HOME/Library/Python/3.11/bin/opensandbox-server" \
    "$HOME/Library/Python/3.10/bin/opensandbox-server" \
    "/usr/local/bin/opensandbox-server" \
    "/opt/homebrew/bin/opensandbox-server"; do
    if [[ -x "$candidate" ]]; then
      OPENSANDBOX_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$OPENSANDBOX_BIN" ]]; then
  print_error "opensandbox-server binary not found in PATH after install."
  echo "  Make sure your Python user base bin directory is on your PATH."
  exit 1
fi

print_step "Using opensandbox-server at: ${OPENSANDBOX_BIN}"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.terragon.worker</string>

    <key>ProgramArguments</key>
    <array>
        <string>${OPENSANDBOX_BIN}</string>
        <string>--config</string>
        <string>${OPENSANDBOX_CONFIG}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${WORKER_DIR}/opensandbox.log</string>

    <key>StandardErrorPath</key>
    <string>${WORKER_DIR}/opensandbox.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${WORKER_DIR}</string>
</dict>
</plist>
PLIST

print_ok "Plist written to: ${PLIST_PATH}"

# Unload any existing instance before loading
if launchctl list | grep -q "com.terragon.worker" 2>/dev/null; then
  print_step "Unloading existing service instance..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

print_step "Loading and starting the launchd service..."
launchctl load "$PLIST_PATH"
print_ok "Service loaded."

# Give it a moment to start
sleep 3

# Verify server health
print_step "Verifying server health at http://localhost:8080/health ..."
HEALTH_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sf "http://localhost:8080/health" &>/dev/null; then
    HEALTH_OK=true
    break
  fi
  echo "  ... attempt ${attempt}/5, waiting 3s"
  sleep 3
done

if $HEALTH_OK; then
  print_ok "Server is healthy at http://localhost:8080/health"
else
  print_warn "Health check did not succeed yet. The server may still be starting."
  echo "  Check logs at: ${WORKER_DIR}/opensandbox.log"
  echo "  Check errors at: ${WORKER_DIR}/opensandbox.err"
fi

# ---------------------------------------------------------------------------
# QR Code registration payload
# ---------------------------------------------------------------------------
REGISTRATION_JSON=$(cat <<JSON
{"name":"${WORKER_NAME}","tailscaleIp":"${TAILSCALE_IP}","port":8080,"apiKey":"${GENERATED_API_KEY}","osVersion":"${OS_VERSION}","cpuCores":${CPU_CORES},"memoryGB":${MEMORY_GB}}
JSON
)

DEFAULT_APP_URL=${TERRAGON_APP_URL:-"__TERRAGON_APP_URL__"}
echo ""
read -r -p "$(echo -e "${CYAN}Enter Terragon app URL for pairing link [${DEFAULT_APP_URL}]: ${RESET}")" APP_BASE_URL
APP_BASE_URL="${APP_BASE_URL:-$DEFAULT_APP_URL}"
APP_BASE_URL="${APP_BASE_URL%/}"
if [[ ! "$APP_BASE_URL" =~ ^https?:// ]]; then
  print_error "Invalid app URL. It must start with http:// or https://."
  exit 1
fi

PAIRING_QUERY=$(WORKER_NAME="$WORKER_NAME" TAILSCALE_IP="$TAILSCALE_IP" GENERATED_API_KEY="$GENERATED_API_KEY" OS_VERSION="$OS_VERSION" CPU_CORES="$CPU_CORES" MEMORY_GB="$MEMORY_GB" "$PYTHON_BIN" - <<'PY'
import os
from urllib.parse import urlencode

params = {
    "name": os.environ["WORKER_NAME"],
    "tailscaleIp": os.environ["TAILSCALE_IP"],
    "port": 8080,
    "apiKey": os.environ["GENERATED_API_KEY"],
    "osVersion": os.environ["OS_VERSION"],
    "cpuCores": os.environ["CPU_CORES"],
    "memoryGB": os.environ["MEMORY_GB"],
}

print(urlencode(params))
PY
)
PAIRING_URL="${APP_BASE_URL}/internal/admin/mac-minis/scan?${PAIRING_QUERY}"

echo ""
print_header "Worker Registration QR Code"

# Install qrencode if needed
if ! command -v qrencode &>/dev/null; then
  print_step "Installing qrencode for QR code generation..."
  brew install qrencode
fi

echo ""
echo -e "${BOLD}Scan this QR code with any camera app:${RESET}"
echo ""
echo "$PAIRING_URL" | qrencode -t ANSIUTF8
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Setup complete!${RESET}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}Worker name:${RESET}    ${WORKER_NAME}"
echo -e "  ${BOLD}Tailscale IP:${RESET}   ${TAILSCALE_IP}"
echo -e "  ${BOLD}Port:${RESET}           8080"
echo -e "  ${BOLD}API key:${RESET}        ${GENERATED_API_KEY}"
echo -e "  ${BOLD}Config:${RESET}         ${OPENSANDBOX_CONFIG}"
echo -e "  ${BOLD}Logs:${RESET}           ${WORKER_DIR}/opensandbox.log"
echo ""
echo -e "  ${BOLD}Scan the QR code above from the Terragon admin panel:${RESET}"
echo "    1. Open your camera app and scan the QR code above"
echo "    2. Open the pairing link from camera results"
echo "    3. Sign in (if needed) and confirm registration"
echo ""
echo -e "  ${CYAN}Your worker will be registered automatically.${RESET}"
echo ""
echo -e "  ${BOLD}Pairing URL:${RESET}    ${PAIRING_URL}"
echo -e "  ${BOLD}Manual JSON:${RESET}    ${REGISTRATION_JSON}"
echo ""
echo -e "  ${BOLD}To uninstall this worker, run:${RESET}"
echo "    bash setup.sh --uninstall"
echo ""
