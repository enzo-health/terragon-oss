# Codex fixture: account-rate-limits-updated — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `account/rateLimits/updated` notification for rate limit tracking.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "account/rateLimits/updated" — notification method type
- `params.rateLimits`: Rate limit object
  - `rateLimits.requests_per_minute`: Maximum requests allowed per minute
  - `rateLimits.tokens_per_minute`: Maximum tokens allowed per minute
  - `rateLimits.remaining_requests`: Requests still available in current window
  - `rateLimits.remaining_tokens`: Tokens still available in current window
  - `rateLimits.reset_at`: Unix timestamp (milliseconds) when limits reset

## How to re-capture live

1. Send requests to Codex and monitor rate limit consumption
2. Observe Codex app-server output for rate limit updates
3. Capture the `account/rateLimits/updated` notification
4. Verify counts decrease and reset_at is a future timestamp
