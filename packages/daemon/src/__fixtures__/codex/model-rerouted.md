# Codex fixture: model-rerouted — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `model/rerouted` notification when a model request is redirected to an alternative model.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "model/rerouted" — notification method type
- `params.originalModel`: Requested model identifier (e.g., "claude-3-5-sonnet-20241022")
- `params.reroutedModel`: Actual model handling the request (e.g., "claude-3-opus-20250219")
- `params.reason`: Reason for rerouting ("model_overloaded" | "model_unavailable" | "quota_exceeded" | other)

## How to re-capture live

1. Send a request specifying a particular model
2. If that model is unavailable or overloaded, Codex reroutes to an alternative
3. Capture the `model/rerouted` notification
4. Verify `originalModel` differs from `reroutedModel` and reason is populated
