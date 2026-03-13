#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function getMcpEnv(key: string): string | undefined {
  if (process.env[key] !== undefined) return process.env[key] || undefined;
  try {
    const env = JSON.parse(readFileSync("/tmp/terragon-mcp-env.json", "utf-8"));
    return env[key] ?? undefined;
  } catch {
    return undefined;
  }
}

const server = new Server(
  {
    name: "terragon-mcp-server",
    version: "0.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const followupTaskDescription = `
Suggest a follow-up task to the user. The user will have the option to spin up another copy of Terry to run and process this task. 
Give all of the context required to do this task effectively. Use this tool anytime you think there are tasks the user should do but
don't make sense to do in the current thread. Examples of these include:

- Different options of approaches a user could take to solve a problem.
- Different steps in a long term plan.
- A follow up task to a previous task in the current thread.
- If the user asks for a task suggestion.
`;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "SuggestFollowupTask",
        description: followupTaskDescription,
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "A concise title for the follow-up task",
            },
            description: {
              type: "string",
              description:
                "A detailed description of what the follow-up task entails. Include all of the context required to do this task effectively.",
            },
          },
          required: ["title", "description"],
        },
      },
      {
        name: "PermissionPrompt",
        description: "Internal permission handler for plan mode operations.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: {
              type: "string",
              description: "The name of the tool requesting permission",
            },
          },
          required: ["tool_name"],
        },
      },
      {
        name: "MarkImplementingTasksComplete",
        description:
          "Mark plan tasks as complete during the implementing phase. Call this after completing each plan task or batch-mark all completed tasks at the end.",
        inputSchema: {
          type: "object",
          properties: {
            completedTasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  stableTaskId: {
                    type: "string",
                    description: "The stable task ID from the plan",
                  },
                  status: {
                    type: "string",
                    enum: ["done", "skipped", "blocked"],
                    description:
                      "Task completion status. Defaults to 'done' if omitted.",
                  },
                  note: {
                    type: "string",
                    description:
                      "Optional note about the completion (e.g., what was implemented)",
                  },
                },
                required: ["stableTaskId"],
              },
            },
          },
          required: ["completedTasks"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "SuggestFollowupTask": {
      return {
        content: [
          {
            type: "text",
            text: "✅ Task suggestion presented to the user.",
          },
        ],
      };
    }
    case "PermissionPrompt": {
      const { tool_name } = request.params.arguments as {
        tool_name: string;
      };

      // Log the permission request for debugging
      console.error(`Permission requested for tool "${tool_name}"`);
      // Check if this is for ExitPlanMode
      if (tool_name === "ExitPlanMode") {
        // For ExitPlanMode, return a user-friendly message
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "deny",
                message: "✏️ User is reviewing the plan.",
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: `Unexpected tool "${tool_name}" requested permission. Only ExitPlanMode is supported.\n\n${JSON.stringify(request.params.arguments)}`,
            }),
          },
        ],
      };
    }
    case "MarkImplementingTasksComplete": {
      const { completedTasks } = request.params.arguments as {
        completedTasks: Array<{
          stableTaskId: string;
          status?: "done" | "skipped" | "blocked";
          note?: string;
        }>;
      };

      const serverUrl = getMcpEnv("TERRAGON_SERVER_URL");
      const daemonToken = getMcpEnv("DAEMON_TOKEN");
      const threadId = getMcpEnv("TERRAGON_THREAD_ID");
      const threadChatId = getMcpEnv("TERRAGON_THREAD_CHAT_ID");

      if (!serverUrl || !daemonToken || !threadId || !threadChatId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "⚠️ Missing environment context for marking tasks. Tasks will be verified at turn completion instead.",
            },
          ],
        };
      }

      // Capture current git HEAD for evidence
      let headSha: string | null = null;
      try {
        const sha = execSync("git rev-parse HEAD 2>/dev/null", {
          encoding: "utf-8",
        }).trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) {
          headSha = sha;
        }
      } catch {
        /* no git repo */
      }

      try {
        const response = await fetch(
          `${serverUrl.replace(/\/+$/, "")}/api/sdlc/mark-tasks`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Daemon-Token": daemonToken,
            },
            body: JSON.stringify({
              threadId,
              threadChatId,
              headSha,
              completedTasks: completedTasks.map((t) => ({
                stableTaskId: t.stableTaskId,
                status: t.status ?? "done",
                note: t.note ?? null,
              })),
            }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          console.error(
            `MarkImplementingTasksComplete failed: ${response.status} ${errorText}`,
          );
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `⚠️ Failed to mark tasks (${response.status}). Tasks will be verified at turn completion.`,
              },
            ],
          };
        }

        const result = (await response.json()) as {
          updatedTaskCount?: number;
        };
        return {
          content: [
            {
              type: "text",
              text: `✅ Marked ${result.updatedTaskCount ?? completedTasks.length} task(s) as complete.`,
            },
          ],
        };
      } catch (error) {
        console.error("MarkImplementingTasksComplete error:", error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "⚠️ Failed to reach server to mark tasks. Tasks will be verified at turn completion.",
            },
          ],
        };
      }
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
