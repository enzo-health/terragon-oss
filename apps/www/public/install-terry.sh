#!/usr/bin/env bash

set -euo pipefail

REPO="terragon-labs/terragon"
ASSET_NAME="terry-cli.tar.gz"
BIN_DIR="${TERRY_INSTALL_BIN_DIR:-"$HOME/.local/bin"}"
INSTALL_ROOT="${TERRY_INSTALL_DIR:-"$HOME/.local/share/terry-cli"}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command tar
require_command node
require_command npm

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

release_metadata="$(
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: terry-installer" \
    "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | node -e '
const fs = require("node:fs");

const releases = JSON.parse(fs.readFileSync(0, "utf8"));
const cliRelease = releases.find((release) => {
  return (
    !release.draft &&
    !release.prerelease &&
    typeof release.tag_name === "string" &&
    release.tag_name.startsWith("cli-v")
  );
});

if (!cliRelease) {
  console.error("No CLI release found.");
  process.exit(1);
}

const asset = cliRelease.assets.find((candidate) => candidate.name === process.argv[1]);

if (!asset || typeof asset.browser_download_url !== "string") {
  console.error(`Release ${cliRelease.tag_name} is missing ${process.argv[1]}.`);
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    tagName: cliRelease.tag_name,
    assetUrl: asset.browser_download_url,
  }),
);
' "$ASSET_NAME"
)"

version="$(
  printf '%s' "$release_metadata" | node -e '
const fs = require("node:fs");
const metadata = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(metadata.tagName.replace(/^cli-v/, ""));
'
)"

asset_url="$(
  printf '%s' "$release_metadata" | node -e '
const fs = require("node:fs");
const metadata = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(metadata.assetUrl);
'
)"

version_dir="$INSTALL_ROOT/$version"
launcher_path="$BIN_DIR/terry"

mkdir -p "$BIN_DIR" "$version_dir"

echo "Downloading Terry CLI $version..."
curl -fsSL "$asset_url" -o "$tmp_dir/$ASSET_NAME"

rm -rf "$version_dir"
mkdir -p "$version_dir"
tar -xzf "$tmp_dir/$ASSET_NAME" -C "$version_dir"

echo "Installing runtime dependencies..."
npm install --omit=dev --ignore-scripts --prefix "$version_dir" >/dev/null

ln -sfn "$version_dir" "$INSTALL_ROOT/current"

cat > "$launcher_path" <<EOF
#!/usr/bin/env sh
exec node "$INSTALL_ROOT/current/dist/index.js" "\$@"
EOF

chmod +x "$launcher_path"

echo "Terry CLI installed to $launcher_path"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    ;;
  *)
    echo
    echo "Add $BIN_DIR to your PATH to use 'terry' from new shells."
    ;;
esac

echo
echo "Run 'terry auth' to connect your account."
