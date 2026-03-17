/**
 * outbox-types.ts
 *
 * V2 store location for outbox-related types that have active callers.
 * Sourced from packages/shared/src/model/delivery-loop/github-pr-references.ts
 * (which no longer exists on disk; the type was re-exported from the model
 * index but never implemented there).
 */

/**
 * Classifies the failure mode of a delivery-loop outbox publication attempt.
 * Maps to the `last_error_class` / `error_class` columns on `sdlc_loop_outbox`
 * and `sdlc_loop_outbox_attempt`.
 */
export type SdlcOutboxErrorClass =
  | "auth"
  | "quota"
  | "infra"
  | "script"
  | "unknown";
