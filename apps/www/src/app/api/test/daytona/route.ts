import { Daytona } from "@daytonaio/sdk";
import { getTemplateIdForSize } from "@leo/sandbox-image";
import { nanoid } from "nanoid/non-secure";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("This endpoint is only available in development");
  }
  const templateId = getTemplateIdForSize({
    provider: "daytona",
    size: "small",
  });
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  const daytona = new Daytona({ apiKey });
  const startTime = Date.now();
  console.log("Creating sandbox...");
  const sandbox = await daytona.create({
    user: "root",
    snapshot: templateId,
    autoStopInterval: 5, // 5 minutes
    autoArchiveInterval: 1, // 1 minute
    autoDeleteInterval: 1, // 1 day
  });

  console.log(`Created sandbox in ${Date.now() - startTime}ms`);
  const sessionId = nanoid();
  await sandbox.process.createSession(sessionId);
  const commandExecutionResult = await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: `sleep 1 && echo "Hello, world!" && sleep 1 && echo "Hello, world! 2"`,
      runAsync: true,
    },
  );
  const commandId = commandExecutionResult.cmdId!;
  console.log("[commandExecutionResult]", commandExecutionResult);
  await sandbox.process.getSessionCommandLogs(
    sessionId,
    commandId,
    (chunk) => {
      console.log("[stdout]", chunk);
    },
    (chunk) => {
      console.error("[stderr]", chunk);
    },
  );
  const commandResult = await sandbox.process.getSessionCommand(
    sessionId,
    commandId,
  );
  console.log("[commandResult]", commandResult);
  return new Response("OK");
}
