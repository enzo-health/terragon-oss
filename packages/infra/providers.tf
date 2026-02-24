terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}

provider "upstash" {
  api_key = var.upstash_api_key
  email   = var.upstash_email
}
