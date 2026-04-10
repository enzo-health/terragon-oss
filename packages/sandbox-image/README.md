# @leo/sandbox-image

This package contains the Dockerfile and code to create template images for sandbox providers.

Supported providers:

- E2B
- Daytona

## Installation

## Prerequisites

- Daytona CLI (https://www.daytona.io/docs/en/getting-started/#setting-up-the-daytona-cli)
- The E2B CLI is installed with `pnpm i` below.

## Setup

```sh
pnpm i
pnpm e2b auth login
```

## Setup

```sh
pnpm i

# Login to both providers
pnpm e2b auth login
daytona login
```

## Sandbox Resource Configurations

We support two sandbox resource sizes that map to the following configurations:

- **small** (default): 2 vCPU cores and 4GB RAM
- **large**: 4 vCPU cores and 8GB RAM

## Creating Templates

```sh
pnpm create-template:e2b:small
pnpm create-template:e2b:large
pnpm create-template:daytona:small
pnpm create-template:daytona:large
```

**Important:** Templates should not be deleted without careful consideration, as active sandboxes may depend on them.

## Updating Templates

Changes to `templates.json` for non-dev templates should be checked into the repo. Both resource configurations should be kept up-to-date when making changes to the Dockerfile. -->
