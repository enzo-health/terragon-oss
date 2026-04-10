import type { NextRequest } from "next/server";
import {
  validateProviderModel,
  type ModelProvider,
  type ModelValidationResult,
} from "@leo/agent/proxy";

const decoder = new TextDecoder();

const METHODS_WITHOUT_MODELS = new Set(["GET", "HEAD", "DELETE"]);

export async function validateProxyRequestModel({
  request,
  provider,
  bodyBuffer,
}: {
  request: NextRequest;
  provider: ModelProvider;
  bodyBuffer?: ArrayBufferLike;
}): Promise<ModelValidationResult> {
  if (METHODS_WITHOUT_MODELS.has(request.method)) {
    return { valid: true };
  }
  let model: string | null = null;
  if (provider === "google") {
    // For google, the model is in the URL path
    const modelRegex = /\/(v1|v1beta)\/models\/([^\/:]+)/;
    const match = request.nextUrl.pathname.match(modelRegex);
    if (match) {
      model = match[2] ?? null;
    }
  } else {
    const parsedBody = await parseBody(request, bodyBuffer);
    if (!parsedBody) {
      return { valid: true };
    }
    model = parsedBody.model;
  }
  return validateProviderModel({ provider, model });
}

async function parseBody(
  request: NextRequest,
  bodyBuffer?: ArrayBufferLike,
): Promise<{ model: string | null; rawModel: string | null } | null> {
  const buffer = await getBodyBuffer(request, bodyBuffer);
  if (!buffer) {
    return null;
  }

  try {
    const bodyText = decoder.decode(buffer as ArrayBuffer);
    if (!bodyText) {
      return null;
    }
    const json = JSON.parse(bodyText);
    const rawModel = (json?.model ?? null) as string | null;
    const model = typeof rawModel === "string" ? rawModel.trim() : null;
    return { model, rawModel };
  } catch (_error) {
    // Let upstream APIs handle malformed JSON bodies.
    return null;
  }
}

async function getBodyBuffer(
  request: NextRequest,
  bodyBuffer?: ArrayBufferLike,
): Promise<ArrayBufferLike | null> {
  if (bodyBuffer) {
    return bodyBuffer.byteLength > 0 ? bodyBuffer : null;
  }

  try {
    const cloned = request.clone();
    const buffer = await cloned.arrayBuffer();
    return buffer.byteLength > 0 ? buffer : null;
  } catch (_error) {
    return null;
  }
}
