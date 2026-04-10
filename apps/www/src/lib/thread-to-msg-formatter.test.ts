import { describe, it, expect } from "vitest";
import { formatThreadToMsg } from "./thread-to-msg-formatter";
import { DBMessage } from "@leo/shared";

describe("formatThreadToMsg", () => {
  it("should format user and agent messages correctly", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Hello, how are you?" }],
      },
      {
        type: "agent",
        parts: [
          {
            type: "text",
            text: "I'm doing well, thank you! How can I help you today?",
          },
        ],
        parent_tool_use_id: null,
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Can you explain what recursion is?" }],
      },
      {
        type: "agent",
        parts: [
          {
            type: "text",
            text: "Recursion is a programming concept where a function calls itself.",
          },
          {
            type: "text",
            text: "It's commonly used to solve problems that can be broken down into smaller, similar subproblems.",
          },
        ],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Hello, how are you?

      Assistant: I'm doing well, thank you! How can I help you today?

      User: Can you explain what recursion is?

      Assistant: Recursion is a programming concept where a function calls itself.
      It's commonly used to solve problems that can be broken down into smaller, similar subproblems."
    `);
  });

  it("should include tool calls and results", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [
          { type: "text", text: "List the files in the current directory" },
        ],
      },
      {
        type: "tool-call",
        id: "tool-123",
        name: "bash",
        parameters: { command: "ls -la" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-123",
        result:
          "total 48\ndrwxr-xr-x  5 user  staff   160 Dec 10\n-rw-r--r--  1 user  staff  1234 Dec 10 file1.txt\n-rw-r--r--  1 user  staff  5678 Dec 10 file2.txt",
        is_error: false,
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [
          {
            type: "text",
            text: "I've listed the files in the current directory. You have two files: file1.txt and file2.txt.",
          },
        ],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: List the files in the current directory

      Tool Call: bash(command="ls -la")

      Tool Result: total 48
      drwxr-xr-x  5 user  staff   160 Dec 10
      -rw-r--r--  1 user  staff  1234 Dec 10 file1.txt
      -rw-r--r--  1 user  staff  5678 Dec 10 file2.txt

      Assistant: I've listed the files in the current directory. You have two files: file1.txt and file2.txt."
    `);
  });

  it("should handle complex tool parameters", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Create a new file" }],
      },
      {
        type: "tool-call",
        id: "tool-456",
        name: "write_file",
        parameters: {
          path: "/home/user/test.py",
          content:
            "def hello():\n    print('Hello, World!')\n\nif __name__ == '__main__':\n    hello()",
          encoding: "utf-8",
          mode: "w",
        },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-456",
        result: "File created successfully",
        is_error: false,
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Create a new file

      Tool Call: write_file
      Parameters: {
        "path": "/home/user/test.py",
        "content": "def hello():\\n    print('Hello, World!')\\n\\nif __name__ == '__main__':\\n    hello()",
        "encoding": "utf-8",
        "mode": "w"
      }

      Tool Result: File created successfully"
    `);
  });

  it("should handle tool errors", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Run a command" }],
      },
      {
        type: "tool-call",
        id: "tool-789",
        name: "bash",
        parameters: { command: "invalid-command" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-789",
        result: "bash: invalid-command: command not found",
        is_error: true,
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Run a command

      Tool Call: bash(command="invalid-command")

      Tool Error: bash: invalid-command: command not found"
    `);
  });

  it("should truncate very long tool results", async () => {
    const longResult = "a".repeat(2000);
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Show me something" }],
      },
      {
        type: "tool-call",
        id: "tool-999",
        name: "read_file",
        parameters: { path: "large.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-999",
        result: longResult,
        is_error: false,
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Show me something

      Tool Call: read_file(path="large.txt")

      Tool Result: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa... [truncated]"
    `);
  });

  it("should skip error messages", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "error",
        error_type: "rate_limit",
        error_info: "You have exceeded the rate limit. Please try again later.",
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Do something"
    `);
  });

  it("should skip error messages with missing fields", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
      },
      {
        type: "error",
        error_type: undefined,
        error_info: "Something went wrong",
      },
      {
        type: "error",
        error_type: "timeout",
        error_info: undefined,
      },
      {
        type: "error",
        error_type: undefined,
        error_info: undefined,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Response after errors" }],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: First message

      Assistant: Response after errors"
    `);
  });

  it("should handle messages with images", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [
          { type: "text", text: "Look at this: " },
          {
            type: "image",
            image_url: "https://example.com/image.png",
            mime_type: "image/png",
          },
          { type: "text", text: " What do you see?" },
        ],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "I can see an image in your message." }],
        parent_tool_use_id: null,
      },
    ];
    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Look at this: <image> What do you see?

      Assistant: I can see an image in your message."
    `);
  });

  it("should skip agent thinking parts", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "What is 2+2?" }],
      },
      {
        type: "agent",
        parts: [
          {
            type: "thinking",
            thinking: "This is a simple arithmetic question.",
          },
          { type: "text", text: "2+2 equals 4." },
        ],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: What is 2+2?

      Assistant: 2+2 equals 4."
    `);
  });

  it("should return empty string for empty messages array", async () => {
    const messages: DBMessage[] = [];
    const result = await formatThreadToMsg(messages);
    expect(result).toBe("");
  });

  it("should handle tool calls with no parameters", async () => {
    const messages: DBMessage[] = [
      {
        type: "tool-call",
        id: "tool-111",
        name: "get_current_time",
        parameters: {},
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "Tool Call: get_current_time()"
    `);
  });

  it("should only include messages after clear-context system message", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "First response" }],
        parent_tool_use_id: null,
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [{ type: "text", text: "Context cleared" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Second message" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Second response" }],
        parent_tool_use_id: null,
      },
    ];
    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Second message

      Assistant: Second response"
    `);
  });

  it("should only include messages after compact-result system message", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Old message" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Compaction complete" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "New message" }],
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: The user has run out of context. This is a summary of what has been done: <summary>
      Compaction complete
      </summary>

      User: New message"
    `);
  });

  it("should use the last context reset when multiple exist", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Message 1" }],
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [{ type: "text", text: "First clear" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Message 2" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Second clear" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Message 3" }],
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: The user has run out of context. This is a summary of what has been done: <summary>
      Second clear
      </summary>

      User: Message 3"
    `);
  });

  it("should format retry-git-commit-and-push system messages", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Create a PR" }],
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [
          {
            type: "text",
            text: "Please retry git commit and push",
          },
        ],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "PR created successfully" }],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Create a PR

      User: Please retry git commit and push

      Assistant: PR created successfully"
    `);
  });

  it("should format fix-github-checks system messages", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Working on it..." }],
        parent_tool_use_id: null,
      },
      {
        type: "system",
        message_type: "fix-github-checks",
        parts: [{ type: "text", text: "Please fix CI" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Resume" }],
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Do something

      Assistant: Working on it...

      User: Please fix CI

      User: Resume"
    `);
  });

  it("should format generic-retry system messages", async () => {
    const messages: DBMessage[] = [
      {
        type: "system",
        message_type: "generic-retry",
        parts: [{ type: "text", text: "Sandbox resumed successfully" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Continue working" }],
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Sandbox resumed successfully

      User: Continue working"
    `);
  });

  it("should handle system messages with multiple parts", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Check status" }],
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [
          { type: "text", text: "Sandbox status: " },
          { type: "text", text: "Running on port 3000" },
        ],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Status received" }],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Check status

      User: Sandbox status: Running on port 3000

      Assistant: Status received"
    `);
  });

  it("should handle system messages that produce no user message", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
      },
      {
        type: "system",
        message_type: "unknown-type" as any,
        parts: [],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Response" }],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: First message

      Assistant: Response"
    `);
  });

  it("should clear context only after clear-context, not before", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Message before clear" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Response before clear" }],
        parent_tool_use_id: null,
      },
      {
        type: "system",
        message_type: "clear-context",
        parts: [{ type: "text", text: "Context cleared" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Message after clear" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Response after clear" }],
        parent_tool_use_id: null,
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: Message after clear

      Assistant: Response after clear"
    `);
  });

  it("should include compact-result message when starting from compact-result", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Old message" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Summary: Completed tasks A, B, and C" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "What's next?" }],
      },
    ];

    const result = await formatThreadToMsg(messages);
    expect(result).toMatchInlineSnapshot(`
      "User: The user has run out of context. This is a summary of what has been done: <summary>
      Summary: Completed tasks A, B, and C
      </summary>

      User: What's next?"
    `);
    // Should NOT include old message before compact-result
    expect(result).not.toContain("Old message");
  });
});
