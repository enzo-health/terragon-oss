# ─────────────────────────────────────────────────
# 1. Upstash — Redis
# ─────────────────────────────────────────────────

resource "upstash_redis_database" "main" {
  database_name  = "terragon"
  region         = "global"
  primary_region = "us-west-2"
  tls            = true
}

# ─────────────────────────────────────────────────
# 2. Cloudflare R2 — File Storage
# ─────────────────────────────────────────────────

resource "cloudflare_r2_bucket" "public" {
  account_id = var.cloudflare_account_id
  name       = "terragon-public"
  location   = "enam"
}

resource "cloudflare_r2_bucket" "private" {
  account_id = var.cloudflare_account_id
  name       = "terragon-private"
  location   = "enam"
}

# ─────────────────────────────────────────────────
# 3. Vercel — Frontend (apps/www)
#
# DATABASE_URL is managed via Vercel's Neon integration.
# ─────────────────────────────────────────────────

resource "vercel_project" "www" {
  name            = "terragon"
  framework       = "nextjs"
  root_directory  = "apps/www"
  build_command   = "turbo run build --filter=@terragon/bundled && next build"
  install_command = "pnpm install --frozen-lockfile"

  resource_config = {
    function_default_regions = ["iad1"]
  }

  git_repository = {
    type = "github"
    repo = var.github_repo
  }
}

# Custom domain — only created if you set var.domain
resource "vercel_project_domain" "www" {
  count      = var.domain != "" ? 1 : 0
  project_id = vercel_project.www.id
  domain     = var.domain
}

# Derive the app URL: custom domain > explicit app_url > auto-generated
locals {
  app_url = var.domain != "" ? "https://${var.domain}" : var.app_url
}

# ── Vercel env vars for apps/www ──────────────────

locals {
  env_vars = {
    # Redis
    REDIS_URL   = "https://${upstash_redis_database.main.endpoint}"
    REDIS_TOKEN = upstash_redis_database.main.password

    # Auth
    BETTER_AUTH_SECRET     = var.better_auth_secret
    BETTER_AUTH_URL        = local.app_url
    ENCRYPTION_MASTER_KEY  = var.encryption_master_key
    INTERNAL_SHARED_SECRET = var.internal_shared_secret

    # AI
    ANTHROPIC_API_KEY = var.anthropic_api_key
    OPENAI_API_KEY    = var.openai_api_key

    # Sandbox
    DAYTONA_API_KEY = var.daytona_api_key

    # GitHub App
    GITHUB_CLIENT_ID            = var.github_client_id
    GITHUB_CLIENT_SECRET        = var.github_client_secret
    GITHUB_APP_ID               = var.github_app_id
    GITHUB_APP_PRIVATE_KEY      = var.github_app_private_key
    GITHUB_WEBHOOK_SECRET       = var.github_webhook_secret
    NEXT_PUBLIC_GITHUB_APP_NAME = var.github_app_name

    # Broadcast (PartyKit on Cloudflare)
    NEXT_PUBLIC_BROADCAST_HOST = var.broadcast_host
    NEXT_PUBLIC_BROADCAST_URL  = var.broadcast_host != "" ? "https://${var.broadcast_host}" : ""

    # R2
    R2_ACCESS_KEY_ID       = var.r2_access_key_id
    R2_SECRET_ACCESS_KEY   = var.r2_secret_access_key
    R2_ACCOUNT_ID          = var.cloudflare_account_id
    R2_BUCKET_NAME         = cloudflare_r2_bucket.public.name
    R2_PRIVATE_BUCKET_NAME = cloudflare_r2_bucket.private.name
    R2_PUBLIC_URL          = var.r2_public_url
  }

  sensitive_keys = toset([
    "REDIS_TOKEN",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_MASTER_KEY",
    "INTERNAL_SHARED_SECRET",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DAYTONA_API_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])
}

resource "vercel_project_environment_variable" "www" {
  for_each = local.env_vars

  project_id = vercel_project.www.id
  key        = each.key
  value      = each.value
  target     = ["production"]
  sensitive  = contains(local.sensitive_keys, each.key)
}

# ─────────────────────────────────────────────────
# 4. Vercel — Docs (apps/docs)
# ─────────────────────────────────────────────────

resource "vercel_project" "docs" {
  name            = "terragon-docs"
  framework       = "nextjs"
  root_directory  = "apps/docs"
  install_command = "pnpm install --frozen-lockfile"

  resource_config = {
    function_default_regions = ["iad1"]
  }

  git_repository = {
    type = "github"
    repo = var.github_repo
  }
}

resource "vercel_project_domain" "docs" {
  count      = var.docs_domain != "" ? 1 : 0
  project_id = vercel_project.docs.id
  domain     = var.docs_domain
}
