# Codex fixture: item-auto-approval-review-completed — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/autoApprovalReview/completed` notification when a review concludes with a decision.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/autoApprovalReview/completed" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.reviewId`: Unique identifier for this review
- `params.targetItemId`: Identifier of the reviewed item
- `params.decision`: Terminal decision ("approved" | "denied")
- `params.rationale`: Human-readable explanation of the decision

## How to re-capture live

1. Allow a review started earlier to complete
2. Observe Codex app-server output as review concludes
3. Capture the `item/autoApprovalReview/completed` notification
4. Verify `decision` and `rationale` are populated
