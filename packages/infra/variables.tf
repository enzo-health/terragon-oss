# ── Provider credentials ──────────────────────────

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" {
  type = string
}

variable "vercel_api_token" {
  type      = string
  sensitive = true
}

variable "vercel_team_id" {
  type    = string
  default = null
}

variable "upstash_api_key" {
  type      = string
  sensitive = true
}

variable "upstash_email" {
  type = string
}

# ── App config ────────────────────────────────────

variable "app_url" {
  type        = string
  description = "Full app URL, e.g. https://terragon-abc123-team.vercel.app (find in Vercel dashboard > Domains)"
}

variable "domain" {
  type        = string
  default     = ""
  description = "Custom domain, e.g. app.yourdomain.com. Leave empty if not using a custom domain."
}

variable "docs_domain" {
  type        = string
  default     = ""
  description = "Docs domain, e.g. docs.yourdomain.com"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo in org/repo format"
}

variable "r2_public_url" {
  type        = string
  description = "Public URL for R2 bucket, e.g. https://pub-xxxxx.r2.dev"
}

# ── R2 S3-compatible credentials (created in CF dashboard) ──

variable "r2_access_key_id" {
  type      = string
  sensitive = true
}

variable "r2_secret_access_key" {
  type      = string
  sensitive = true
}

# ── App secrets ───────────────────────────────────

variable "better_auth_secret" {
  type      = string
  sensitive = true
}

variable "encryption_master_key" {
  type      = string
  sensitive = true
}

variable "internal_shared_secret" {
  type      = string
  sensitive = true
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}

variable "openai_api_key" {
  type      = string
  sensitive = true
}

variable "daytona_api_key" {
  type      = string
  sensitive = true
}

# ── GitHub App ────────────────────────────────────

variable "github_client_id" {
  type      = string
  sensitive = true
}

variable "github_client_secret" {
  type      = string
  sensitive = true
}

variable "github_app_id" {
  type      = string
  sensitive = true
}

variable "github_app_private_key" {
  type      = string
  sensitive = true
}

variable "github_app_name" {
  type = string
}

variable "github_webhook_secret" {
  type      = string
  sensitive = true
}

variable "cron_secret" {
  type      = string
  sensitive = true
}

# ── Broadcast (PartyKit) ─────────────────────────

variable "broadcast_host" {
  type        = string
  default     = ""
  description = "PartyKit host, e.g. broadcast.your-account.partykit.dev (set after partykit deploy)"
}

# ── Optional ──────────────────────────────────────

variable "resend_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_secret_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_price_core_monthly" {
  type    = string
  default = ""
}

variable "stripe_price_pro_monthly" {
  type    = string
  default = ""
}

variable "stripe_price_credit_pack" {
  type    = string
  default = ""
}
