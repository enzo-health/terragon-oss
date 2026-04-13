#!/bin/bash

# Script to create a release tag for the CLI based on package.json version

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CLI_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Change to CLI directory
cd "$CLI_DIR"

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")

if [ -z "$VERSION" ]; then
  echo -e "${RED}Error: Could not extract version from package.json${NC}"
  exit 1
fi

TAG_NAME="cli-v${VERSION}"

echo -e "${YELLOW}Preparing to create release tag: ${TAG_NAME}${NC}"

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo -e "${YELLOW}Warning: You are not on the main branch (current: $CURRENT_BRANCH)${NC}"
  read -p "Do you want to continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Aborted${NC}"
    exit 1
  fi
fi

# Check if there are uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}Error: You have uncommitted changes. Please commit or stash them first.${NC}"
  exit 1
fi

# Check if tag already exists
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  echo -e "${RED}Error: Tag $TAG_NAME already exists${NC}"
  echo "To delete the existing tag and create a new one, run:"
  echo "  git tag -d $TAG_NAME"
  echo "  git push origin :refs/tags/$TAG_NAME"
  exit 1
fi

# Pull latest changes
echo -e "${YELLOW}Pulling latest changes...${NC}"
git pull origin "$CURRENT_BRANCH"

# Create annotated tag
echo -e "${YELLOW}Creating tag $TAG_NAME...${NC}"
git tag -a "$TAG_NAME" -m "Release Terry CLI v${VERSION}

Distribution:
- GitHub Release asset
- Hosted install script
- No npm package publish required

Install: curl -fsSL https://terragon-lake.vercel.app/install-terry.sh | bash"

echo -e "${GREEN}Tag created successfully!${NC}"

# Ask if user wants to push the tag
read -p "Push tag to origin? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}Pushing tag to origin...${NC}"
  git push origin "$TAG_NAME"
  echo -e "${GREEN}Tag pushed successfully!${NC}"
  echo
  echo -e "${GREEN}Release tag $TAG_NAME has been created and pushed.${NC}"
  echo "This will trigger the GitHub Action to publish a GitHub Release asset."
else
  echo -e "${YELLOW}Tag created locally but not pushed.${NC}"
  echo "To push the tag later, run:"
  echo "  git push origin $TAG_NAME"
fi
