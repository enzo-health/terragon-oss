import type { Story, StoryDefault } from "@ladle/react";
import { TaskTool } from "./task-tool";
import { ToolPart } from "../tool-part";

export default {
  title: "Chat/TaskTool",
} satisfies StoryDefault;

const renderToolPart = (
  toolPart: Parameters<typeof ToolPart>[0]["toolPart"],
) => (
  <ToolPart
    toolPart={toolPart}
    threadId="thread-1"
    threadChatId="chat-1"
    messages={[]}
    isReadOnly={false}
    childThreads={[]}
    githubRepoFullName="terragonlabs/terragon"
    repoBaseBranchName="main"
    branchName="feature/task-tool"
  />
);

export const Simple: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-1",
    name: "Task" as const,
    parameters: {
      description: "Search for config files",
      prompt: "Find all configuration files in the project",
    },
    status: "completed" as const,
    result: "Found 5 config files",
    parts: [
      {
        type: "tool" as const,
        agent: "claudeCode" as const,
        id: "glob-1",
        name: "Glob" as const,
        parameters: { pattern: "**/*.config.js" },
        status: "completed" as const,
        result: "Found 5 config files",
        parts: [],
      },
    ],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const Pending: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-2",
    name: "Task" as const,
    parameters: {
      description: "Search for config files",
      prompt: "Find all configuration files in the project",
    },
    status: "pending" as const,
    result: "",
    parts: [
      {
        type: "tool" as const,
        agent: "claudeCode" as const,
        id: "read-1",
        name: "Read" as const,
        parameters: { file_path: "/src/utils/helpers.ts" },
        status: "completed" as const,
        result: "Found 5 config files",
        parts: [],
      },
      {
        type: "tool" as const,
        agent: "claudeCode" as const,
        id: "glob-1",
        name: "Glob" as const,
        parameters: { pattern: "**/*.config.js" },
        status: "pending" as const,
        result: "",
        parts: [],
      },
    ],
  };
  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const Failed: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-5",
    name: "Task" as const,
    parameters: {
      description: "Debug failing tests",
      prompt: "Find and fix failing unit tests",
    },
    status: "error" as const,
    result: "Task failed: Tests configuration missing",
    parts: [
      {
        type: "tool" as const,
        agent: "claudeCode" as const,
        id: "bash-3",
        name: "Bash" as const,
        parameters: { command: "npm test" },
        status: "error" as const,
        result: "Error: Missing test configuration",
        parts: [],
      },
      {
        type: "text" as const,
        text: "Error: Failed to run tests. Missing test configuration.",
      },
    ],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const WithSubagentType: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-agent",
    name: "Task" as const,
    parameters: {
      description: "Handle yeet request",
      prompt:
        "The user has requested to 'call the yeet agent'. Please provide an appropriate response.",
      subagent_type: "yeet-responder",
    },
    status: "completed" as const,
    result:
      "Yeet acknowledged! Ready to help you yeet whatever development tasks you need.",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const WithGeneralPurposeSubagent: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-general",
    name: "Task" as const,
    parameters: {
      description: "Research complex questions",
      prompt: "Search for information about quantum computing applications.",
      subagent_type: "general-purpose",
    },
    status: "completed" as const,
    result:
      "Found comprehensive information about quantum computing applications in cryptography, optimization, and simulation.",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

// Agent Color Stories
export const BugHunterRed: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-bug-hunter",
    name: "Task" as const,
    parameters: {
      description: "Find and fix bugs",
      prompt:
        "Hunt down the null pointer exception in the authentication module",
      subagent_type: "bug-hunter",
      _agent_color: "red",
    },
    status: "completed" as const,
    result: "Found and fixed null pointer exception in auth.service.ts:142",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const CodeReviewerPurple: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-code-reviewer",
    name: "Task" as const,
    parameters: {
      description: "Review recent code changes",
      prompt: "Review the recently implemented user authentication feature",
      subagent_type: "code-reviewer",
      _agent_color: "purple",
    },
    status: "completed" as const,
    result: "Code review completed: 3 minor issues found, overall quality good",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const TestRunnerGreen: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-test-runner",
    name: "Task" as const,
    parameters: {
      description: "Run test suite",
      prompt: "Execute all unit tests and integration tests",
      subagent_type: "test-runner",
      _agent_color: "green",
    },
    status: "completed" as const,
    result: "All tests passed: 156 passed, 0 failed",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const YeetResponderOrange: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-yeet",
    name: "Task" as const,
    parameters: {
      description: "Handle yeet request",
      prompt: "yeet",
      subagent_type: "yeet-responder",
      _agent_color: "orange",
    },
    status: "completed" as const,
    result: "YEET! 🚀 Ready to launch your code into production!",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const AgentBlue: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-blue",
    name: "Task" as const,
    parameters: {
      description: "Analyze database queries",
      prompt: "Optimize slow database queries in the reporting module",
      subagent_type: "database-optimizer",
      _agent_color: "blue",
    },
    status: "completed" as const,
    result: "Optimized 5 queries, reduced average response time by 73%",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const AgentYellow: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-yellow",
    name: "Task" as const,
    parameters: {
      description: "Generate documentation",
      prompt: "Create API documentation for the new endpoints",
      subagent_type: "doc-generator",
      _agent_color: "yellow",
    },
    status: "completed" as const,
    result: "Generated comprehensive API docs with examples for 12 endpoints",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const AgentPink: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-pink",
    name: "Task" as const,
    parameters: {
      description: "Design UI components",
      prompt: "Create accessible form components with proper ARIA labels",
      subagent_type: "ui-designer",
      _agent_color: "pink",
    },
    status: "completed" as const,
    result: "Designed 8 accessible form components with full ARIA support",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};

export const AgentCyan: Story = () => {
  const toolPart = {
    type: "tool" as const,
    agent: "claudeCode" as const,
    id: "task-cyan",
    name: "Task" as const,
    parameters: {
      description: "Analyze performance metrics",
      prompt: "Profile the application and identify performance bottlenecks",
      subagent_type: "performance-analyzer",
      _agent_color: "cyan",
    },
    status: "completed" as const,
    result:
      "Identified 3 major bottlenecks: image loading, bundle size, render cycles",
    parts: [],
  };

  return <TaskTool toolPart={toolPart} renderToolPart={renderToolPart} />;
};
