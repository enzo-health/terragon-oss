# @leo/dev-env

Contains code to setup the development environment for leo.

1. The docker compose file for the dev environment.
2. A script to setup a tunnel to the dev environment.

## Tunnel Setup

You need a tunnel to expose your local development server to the public internet so remote sandboxes can communicate with your local environment.

### Option 1: Ngrok (Preferred, Easiest)

1. Sign up for a free account on [ngrok](https://ngrok.com/)
2. Install ngrok (`brew install ngrok`)
3. Set the `NGROK_AUTH_TOKEN` and `NGROK_DOMAIN` in `.env.development.local`

NGROK_DOMAIN should be static domain that ngrok gives you.

### Option 2: Custom Tunnel Command

As an alternative to ngrok, you can use any tunnel service by setting `CUSTOM_TUNNEL_COMMAND` in `.env.development.local`. This works great with Cloudflare Tunnel and is a good option if you cannot use ngrok for some reason. You'll need a domain name with cloudflare for this to work.

**Cloudflare Tunnel Setup:**

1. Follow the [Cloudflare Tunnel quickstart guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
2. Point a domain to http://localhost:3000 (Eg. `localhost.foobar.com` -> `http://localhost:3000`)
3. After setting up your tunnel, set `CUSTOM_TUNNEL_COMMAND` in `.env.development.local`:

```bash
CUSTOM_TUNNEL_COMMAND="cloudflared tunnel run --token <your-token>"
```

The custom tunnel command will be executed when you run `pnpm dev` instead of ngrok.

## Docker containers setup

If you don't have docker installed, you can install [Orbstack](https://orbstack.dev/). The containers will start automatically when you run `pnpm dev` in the root of the repository.

```bash
pnpm docker-up-dev
```
