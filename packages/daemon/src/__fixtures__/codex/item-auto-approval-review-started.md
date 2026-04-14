# Codex fixture: item-auto-approval-review-started — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/autoApprovalReview/started` notification when Codex initiates an automatic approval review.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/autoApprovalReview/started" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.reviewId`: Unique identifier for this review
- `params.targetItemId`: Identifier of the item being reviewed (e.g., a file change)
- `params.review.riskLevel`: Risk assessment ("low" | "medium" | "high")
- `params.review.action`: Recommended action ("auto_approve" | "request_approval" | "auto_deny")
- `params.action`: Action disposition ("auto_approve" | "request_approval" | "auto_deny")

## How to re-capture live

1. Send a prompt with risky or uncertain changes
2. Observe Codex app-server output as auto-approval review initiates
3. Capture the `item/autoApprovalReview/started` notification
4. Verify `riskLevel` and `action` reflect appropriate caution levels
