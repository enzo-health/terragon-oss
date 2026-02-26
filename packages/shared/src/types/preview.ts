import type { SandboxProvider } from "@terragon/types/sandbox";

export const threadRunStatuses = [
  "booting",
  "running",
  "validating",
  "finished",
  "failed",
] as const;

export type ThreadRunStatus = (typeof threadRunStatuses)[number];

export const threadRunTriggerSources = [
  "ui",
  "retry",
  "follow_up_queue",
  "scheduled",
  "slash_command",
  "system",
] as const;

export type ThreadRunTriggerSource = (typeof threadRunTriggerSources)[number];

export type FrozenRunFlagSnapshot = {
  sandboxPreview: boolean;
  daemonRunIdStrict: boolean;
  rolloutPhase: number | null;
};

export const threadUiValidationOutcomes = [
  "not_required",
  "pending",
  "passed",
  "failed",
  "inconclusive",
  "blocked",
] as const;

export type ThreadUiValidationOutcome =
  (typeof threadUiValidationOutcomes)[number];

export const threadUiReadyDowngradeStates = [
  "not_attempted",
  "converted_to_draft",
  "conversion_failed",
  "not_supported",
] as const;

export type ThreadUiReadyDowngradeState =
  (typeof threadUiReadyDowngradeStates)[number];

export const previewSessionStates = [
  "pending",
  "initializing",
  "ready",
  "unsupported",
  "expired",
  "revoked",
  "error",
] as const;

export type PreviewSessionState = (typeof previewSessionStates)[number];

export const previewUnsupportedReasons = [
  "missing_config",
  "adapter_unimplemented",
  "ws_required",
  "frame_bust",
  "capability_missing",
  "cookie_blocked",
  "proxy_denied",
] as const;

export type PreviewUnsupportedReason =
  (typeof previewUnsupportedReasons)[number];

export const previewOpenModes = ["iframe", "new_tab"] as const;

export type PreviewOpenMode = (typeof previewOpenModes)[number];

export const previewPinningModes = [
  "strict_ip",
  "provider_asn",
  "tls_sni_host",
] as const;

export type PreviewPinningMode = (typeof previewPinningModes)[number];

export const previewValidationAttemptStatuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "inconclusive",
  "unsupported",
] as const;

export type PreviewValidationAttemptStatus =
  (typeof previewValidationAttemptStatuses)[number];

export const previewValidationDiffSources = [
  "sha",
  "working-tree-fallback",
] as const;

export type PreviewValidationDiffSource =
  (typeof previewValidationDiffSources)[number];

export const previewValidationTimeoutCode = "ETERRAGON_TIMEOUT" as const;
export const previewValidationTimeoutReason = "timeout_killed" as const;

export const daemonEventQuarantineReasons = [
  "missing_run_id",
  "mismatch",
  "legacy_mode",
  "payload_version_mismatch",
  "missing_end_sha",
] as const;

export type DaemonEventQuarantineReason =
  (typeof daemonEventQuarantineReasons)[number];

export const previewSecurityReasons = [
  "expired",
  "revoked",
  "signature_mismatch",
  "binding_mismatch",
  "permission_denied",
  "token_replay",
  "rate_limited",
  "cache_unavailable",
  "proxy_ssrf_blocked",
  "proxy_path_denied",
] as const;

export type PreviewSecurityReason = (typeof previewSecurityReasons)[number];

export const previewEventNames = [
  "v1.preview.session.state_changed",
  "v1.preview.validation.attempt_started",
  "v1.preview.validation.attempt_finished",
  "v1.preview.access.denied",
] as const;

export type PreviewEventName = (typeof previewEventNames)[number];

export const previewSessionTTLSeconds = 1800;
export const previewBroadcastSchemaVersion = 1;
export const previewTokenIssuer = "terragon-preview" as const;
export const previewTokenAudiences = {
  exchange: "preview-session-exchange",
  broadcast: "preview-session-broadcast",
  cookie: "preview-session-cookie",
  origin: "preview-upstream-origin",
} as const;
export const previewKeyNamespaces = {
  exchange: "exchange",
  broadcast: "broadcast",
  cookie: "cookie",
  origin: "origin",
} as const;

export type PreviewTokenNamespace =
  (typeof previewKeyNamespaces)[keyof typeof previewKeyNamespaces];
export type PreviewTokenAudience =
  (typeof previewTokenAudiences)[keyof typeof previewTokenAudiences];

export type PreviewPinnedUpstreamIps = {
  addressesV4: string[];
  addressesV6: string[];
  cnameChain: string[];
  ttlSeconds: number;
  resolvedAt: string;
  pinningMode: PreviewPinningMode;
};

export type PreviewAuthClaimTuple = {
  previewSessionId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
  userId: string;
  codesandboxId: string;
  sandboxProvider: SandboxProvider;
};

export type PreviewExchangeAuthClaimTuple = PreviewAuthClaimTuple & {
  nonce: string;
};

export type PreviewCookieAuthClaimTuple = PreviewAuthClaimTuple & {
  revocationVersion: number;
};

export type PreviewBroadcastAuthClaimTuple = PreviewAuthClaimTuple & {
  schemaVersion: number;
  channelType: "preview";
};

export type PreviewUpstreamOriginClaims = {
  scheme: "http" | "https";
  host: string;
  port: number;
  pinningMode: PreviewPinningMode;
  exp: number;
  previewSessionId: string;
  revocationVersion: number;
};
