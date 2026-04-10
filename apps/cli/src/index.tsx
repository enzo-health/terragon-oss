#!/usr/bin/env node
import { program } from "commander";
import { render } from "ink";
import React from "react";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { AuthCommand } from "./commands/auth.js";
import { PullCommand } from "./commands/pull.js";
import { CreateCommand } from "./commands/create.js";
import { ListCommand } from "./commands/list.js";
import { QueryProvider } from "./providers/QueryProvider.js";
import { RootLayout } from "./components/RootLayout.js";
import { startMCPServer } from "./mcp-server/index.js";
import { QACommand } from "./commands/qa.js";
import type { AIModelExternal } from "@terragon/agent/types";

// Set up global error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  console.error("Stack trace:", error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise);
  console.error("Reason:", reason);
  process.exit(1);
});

// Get package.json for version checking
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  await readFile(join(__dirname, "../package.json"), "utf-8"),
);

program
  .name("terry")
  .description("Terry CLI - Terragon Labs coding assistant")
  .version(packageJson.version);

program
  .command("auth [apiKey]")
  .description("Authenticate with your Terragon API key")
  .action((apiKey: string | undefined) => {
    render(
      <QueryProvider>
        <RootLayout>
          <AuthCommand apiKey={apiKey} />
        </RootLayout>
      </QueryProvider>,
    );
  });

program
  .command("pull [threadId]")
  .description("Fetch session data for a task")
  .option("-r, --resume", "Automatically launch Claude after pulling")
  .action((threadId: string | undefined, options: { resume?: boolean }) => {
    render(
      <QueryProvider>
        <RootLayout>
          <PullCommand threadId={threadId} resume={options.resume} />
        </RootLayout>
      </QueryProvider>,
    );
  });

const CLI_MODEL_OPTIONS: AIModelExternal[] = [
  "amp",
  "haiku",
  "opus",
  "opus[1m]",
  "sonnet",
  "sonnet[1m]",
  "gpt-5.4",
  "gpt-5.4-low",
  "gpt-5.4-medium",
  "gpt-5.4-high",
  "gpt-5.4-xhigh",
  "gpt-5.4-mini",
  "gpt-5.4-mini-low",
  "gpt-5.4-mini-medium",
  "gpt-5.4-mini-high",
  "gpt-5.4-mini-xhigh",
  "gpt-5.4-nano",
  "gpt-5.4-nano-low",
  "gpt-5.4-nano-medium",
  "gpt-5.4-nano-high",
  "gpt-5.4-nano-xhigh",
  "grok-code",
  "qwen3-coder",
  "kimi-k2.5",
  "glm-5.1",
  "opencode/grok-code",
  "opencode/qwen3-coder",
  "opencode/kimi-k2.5",
  "opencode/glm-5.1",
  "opencode/gemini-2.5-pro",
  "gemini-3-pro",
  "gemini-2.5-pro",
];

program
  .command("create <message>")
  .description("Create a new task with the given message")
  .option(
    "-r, --repo <repo>",
    "GitHub repository (default: current repository)",
  )
  .option(
    "-b, --branch <branch>",
    "Base branch name (default: repo default branch for new tasks)",
  )
  .option("--no-new-branch", "Don't create a new branch")
  .option("-m, --model <model>", `AI model: ${CLI_MODEL_OPTIONS.join(", ")}`)
  .option("-M, --mode <mode>", "Task mode: plan or execute (default: execute)")
  .action(
    (
      message: string,
      options: {
        repo?: string;
        branch?: string;
        newBranch: boolean;
        mode?: string;
        model?: string;
      },
    ) => {
      // Validate mode value and default to execute
      const mode = options.mode === "plan" ? "plan" : "execute";
      let model: AIModelExternal | undefined;
      if (options.model) {
        if (CLI_MODEL_OPTIONS.includes(options.model as any)) {
          model = options.model as AIModelExternal;
        } else {
          console.warn(
            `Warning: Model '${options.model}' is not recognized. Valid models are: ${CLI_MODEL_OPTIONS.join(", ")}. Using default model.`,
          );
          model = undefined;
        }
      }
      render(
        <QueryProvider>
          <RootLayout>
            <CreateCommand
              message={message}
              repo={options.repo}
              branch={options.branch}
              createNewBranch={options.newBranch}
              mode={mode}
              model={model}
            />
          </RootLayout>
        </QueryProvider>,
      );
    },
  );

program
  .command("list")
  .description("List all tasks in a non-interactive format")
  .action(() => {
    render(
      <QueryProvider>
        <RootLayout>
          <ListCommand />
        </RootLayout>
      </QueryProvider>,
    );
  });

program
  .command("mcp")
  .description("Run an MCP server for the git repository")
  .action(async () => {
    try {
      await startMCPServer();
    } catch (error) {
      console.error("Failed to start MCP server:", error);
      process.exit(1);
    }
  });

const qaCommand = program
  .command("qa")
  .description("Quality assurance - validate task consistency");

qaCommand
  .command("verify <threadId>")
  .description(
    "Validate a thread's consistency across UI, database, and container",
  )
  .option("-d, --deep", "Include deep validation (event journal, signals)")
  .option("-j, --json", "Output results as JSON")
  .option(
    "-f, --fail-on-discrepancy",
    "Exit with error code if discrepancies found",
  )
  .action(
    (
      threadId: string,
      options: { deep?: boolean; json?: boolean; failOnDiscrepancy?: boolean },
    ) => {
      render(
        <QueryProvider>
          <RootLayout>
            <QACommand
              command="verify"
              threadId={threadId}
              options={{
                deep: options.deep,
                json: options.json,
                failOnDiscrepancy: options.failOnDiscrepancy,
              }}
            />
          </RootLayout>
        </QueryProvider>,
      );
    },
  );

qaCommand
  .command("watch <threadId>")
  .description("Continuously validate a thread with polling")
  .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
  .option("-t, --timeout <ms>", "Total timeout in milliseconds", "600000")
  .option("-f, --fail-on-discrepancy", "Exit if critical discrepancies found")
  .action(
    (
      threadId: string,
      options: {
        interval?: string;
        timeout?: string;
        failOnDiscrepancy?: boolean;
      },
    ) => {
      render(
        <QueryProvider>
          <RootLayout>
            <QACommand
              command="watch"
              threadId={threadId}
              options={{
                pollInterval: parseInt(options.interval || "30000", 10),
                timeout: parseInt(options.timeout || "600000", 10),
                failOnDiscrepancy: options.failOnDiscrepancy,
              }}
            />
          </RootLayout>
        </QueryProvider>,
      );
    },
  );

program.parse();
