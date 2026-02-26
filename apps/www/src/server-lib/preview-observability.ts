import { getPostHogServer } from "@/lib/posthog-server";
import type {
  PreviewEventOrigin,
  PreviewMetricName,
  PreviewSecurityReason,
} from "@terragon/shared/types/preview";
import { previewObservabilitySchemaVersion } from "@terragon/shared/types/preview";
import type { SandboxProvider } from "@terragon/types/sandbox";

type PreviewObservabilityBase = {
  origin: PreviewEventOrigin;
  traceId: string;
  threadId?: string;
  threadChatId?: string;
  runId?: string;
  previewSessionId?: string;
  proxyReqId?: string;
};

type PreviewDimensions = {
  userId: string | null;
  repoFullName?: string | null;
  sandboxProvider?: SandboxProvider | null;
};

function capturePreviewEvent({
  event,
  base,
  dimensions,
  properties,
}: {
  event: string;
  base: PreviewObservabilityBase;
  dimensions: PreviewDimensions;
  properties?: Record<string, unknown>;
}) {
  getPostHogServer().capture({
    distinctId: dimensions.userId ?? "preview-system",
    event,
    properties: {
      schemaVersion: previewObservabilitySchemaVersion,
      origin: base.origin,
      tsServer: new Date().toISOString(),
      traceId: base.traceId,
      threadId: base.threadId ?? null,
      threadChatId: base.threadChatId ?? null,
      runId: base.runId ?? null,
      previewSessionId: base.previewSessionId ?? null,
      proxyReqId: base.proxyReqId ?? null,
      repoFullName: dimensions.repoFullName ?? null,
      sandboxProvider: dimensions.sandboxProvider ?? null,
      ...properties,
    },
  });
}

export function emitPreviewMetric({
  metricName,
  base,
  dimensions,
  properties,
}: {
  metricName: PreviewMetricName;
  base: PreviewObservabilityBase;
  dimensions: PreviewDimensions;
  properties?: Record<string, unknown>;
}) {
  capturePreviewEvent({
    event: metricName,
    base,
    dimensions,
    properties,
  });
}

export function emitPreviewAccessDenied({
  reason,
  status,
  base,
  dimensions,
  properties,
}: {
  reason: PreviewSecurityReason;
  status: number;
  base: PreviewObservabilityBase;
  dimensions: PreviewDimensions;
  properties?: Record<string, unknown>;
}) {
  capturePreviewEvent({
    event: "v1.preview.access.denied",
    base,
    dimensions,
    properties: {
      reason,
      status,
      ...properties,
    },
  });
}
