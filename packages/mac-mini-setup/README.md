# @terragon/mac-mini-setup

Mac Mini sandbox worker setup script for Terragon. This script is served by the Terragon web app at `GET /api/mac-mini-setup.sh` and configures a Mac Mini as a remote sandbox worker.

## What it does

Running `setup.sh` on a Mac Mini will:

1. Verify prerequisites: macOS, at least 20 GB of free disk space, and Python 3.10+
2. Install Homebrew (if not present)
3. Install Tailscale and prompt you to join your tailnet via `sudo tailscale up`
4. Install OrbStack (preferred) or use an existing Docker Desktop installation as the container runtime
5. Install `opensandbox-server` via pip3
6. Pull the Terragon sandbox Docker image (`ghcr.io/terragon-labs/containers-test:latest`)
7. Generate a random 32-byte API key
8. Write an OpenSandbox configuration file to `~/.terragon-worker/opensandbox.toml`
9. Install a launchd agent (`com.terragon.worker`) so the server starts automatically at login
10. Verify the server health endpoint at `http://localhost:8080/health`
11. Display a QR code in the terminal containing the worker registration payload

After scanning the QR code from the Terragon admin panel (Admin -> Mac Mini Workers -> Scan QR Code), the worker is registered and ready to accept sandbox jobs.

## Usage

```bash
# Download and run directly
curl -fsSL https://your-terragon-app/api/mac-mini-setup.sh | bash

# Or download and inspect first
curl -fsSL https://your-terragon-app/api/mac-mini-setup.sh -o setup.sh
bash setup.sh
```

## What gets installed

| Component              | Method                                                                    | Notes                                                                                       |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Homebrew               | Homebrew install script                                                   | Skipped if already present                                                                  |
| Tailscale              | `brew install tailscale`                                                  | Skipped if already present                                                                  |
| OrbStack               | `brew install --cask orbstack`                                            | Preferred over Docker Desktop                                                               |
| opensandbox-server     | `python -m pip install --user --break-system-packages opensandbox-server` | Uses the detected Python 3.10+ toolchain without modifying the managed Homebrew environment |
| Terragon sandbox image | `docker pull`                                                             | `ghcr.io/terragon-labs/containers-test:latest`                                              |
| qrencode               | `brew install qrencode`                                                   | Used to render QR code in terminal                                                          |

### Files created

- `~/.terragon-worker/opensandbox.toml` — server configuration
- `~/.terragon-worker/opensandbox.log` — stdout log
- `~/.terragon-worker/opensandbox.err` — stderr log
- `~/Library/LaunchAgents/com.terragon.worker.plist` — launchd service definition

## Uninstall

```bash
bash setup.sh --uninstall
```

This stops and unloads the launchd service, removes the plist, removes `~/.terragon-worker/`, and optionally uninstalls `opensandbox-server` via the detected Python toolchain. Homebrew, Tailscale, OrbStack, and Docker Desktop are left in place.

## Notes

- The Docker image name (`TERRAGON_IMAGE` in the script) may differ depending on your Terragon deployment. Edit the variable at the top of the image pull section if you are using a custom registry or tag.
- The `max_sandboxes` value in the generated config defaults to `1`. Increase it based on the available RAM and CPU of your Mac Mini.
- Logs are written to `~/.terragon-worker/opensandbox.log` and `~/.terragon-worker/opensandbox.err`.
