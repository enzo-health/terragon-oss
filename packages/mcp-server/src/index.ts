#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
