import { NextRequest, NextResponse } from "next/server";

const TASK_LIVENESS_SECRET_ENV_KEY = "TASK_LIVENESS_TEST_SECRET";
const TASK_LIVENESS_ENABLE_ENV_KEY = "ENABLE_TASK_LIVENESS_TEST_ENDPOINTS";

export function rejectTaskLivenessTestRequest(
  request: NextRequest,
): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Not found" },
      {
        status: 404,
      },
    );
  }

  const isTestRuntime = process.env.NODE_ENV === "test";
  const isExplicitlyEnabled =
    process.env[TASK_LIVENESS_ENABLE_ENV_KEY] === "true";
  if (!isTestRuntime && !isExplicitlyEnabled) {
    return NextResponse.json(
      {
        error:
          "Task liveness test endpoints are disabled. Set ENABLE_TASK_LIVENESS_TEST_ENDPOINTS=true to opt in.",
      },
      {
        status: 403,
      },
    );
  }

  const configuredSecret = process.env[TASK_LIVENESS_SECRET_ENV_KEY];
  if (!configuredSecret) {
    return NextResponse.json(
      {
        error:
          "TASK_LIVENESS_TEST_SECRET is not configured for task-liveness test endpoints.",
      },
      {
        status: 503,
      },
    );
  }

  const requestSecret = request.headers.get("X-Terragon-Secret");
  if (requestSecret !== configuredSecret) {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
      },
    );
  }

  return null;
}
