output "app_url" {
  value = local.app_url
}

output "redis_endpoint" {
  value = upstash_redis_database.main.endpoint
}

output "redis_port" {
  value = upstash_redis_database.main.port
}

output "redis_password" {
  value     = upstash_redis_database.main.password
  sensitive = true
}

output "r2_public_bucket" {
  value = cloudflare_r2_bucket.public.name
}

output "r2_private_bucket" {
  value = cloudflare_r2_bucket.private.name
}

output "vercel_www_project_id" {
  value = vercel_project.www.id
}

output "vercel_docs_project_id" {
  value = vercel_project.docs.id
}

output "manual_steps" {
  value = <<-EOT
    1. Connect Neon to Vercel project via Vercel dashboard (Storage > Connect > Neon)
    2. Push DB schema: pnpm -C packages/shared drizzle-kit-push-prod
    3. Deploy PartyKit broadcast: cd apps/broadcast && npx partykit deploy
    4. Set NEXT_PUBLIC_BROADCAST_HOST and NEXT_PUBLIC_BROADCAST_URL in Vercel
    5. Set INTERNAL_SHARED_SECRET, BETTER_AUTH_URL, DAYTONA_API_KEY as PartyKit secrets
    6. Build sandbox images: pnpm -C packages/sandbox-image create-template:daytona:small
    7. Configure GitHub App webhook URL to ${local.app_url}/api/webhooks/github
  EOT
}
