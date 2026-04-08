#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "node_modules" ]; then
  pnpm install
fi

if [ ! -f "apps/www/.env.development.local" ]; then
  echo "WARNING: apps/www/.env.development.local is missing; some delivery-loop dev validations may fail."
fi

echo "Mission init complete."
