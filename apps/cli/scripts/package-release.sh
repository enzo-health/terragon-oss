#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-"$CLI_DIR/.release"}"
STAGING_DIR="$OUTPUT_DIR/staging"
ARCHIVE_PATH="$OUTPUT_DIR/terry-cli.tar.gz"

rm -rf "$OUTPUT_DIR"
mkdir -p "$STAGING_DIR"

cd "$CLI_DIR"

pnpm build

cp -R dist "$STAGING_DIR/dist"
cp package.json "$STAGING_DIR/package.json"
cp README.md "$STAGING_DIR/README.md"

tar -C "$STAGING_DIR" -czf "$ARCHIVE_PATH" .

echo "Created release archive at $ARCHIVE_PATH"
