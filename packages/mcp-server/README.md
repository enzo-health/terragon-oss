# @leo/mcp-server

Model Context Protocol (MCP) server providing AI assistant tools for Leo.

## Overview

This MCP server provides tools for enhanced AI assistant capabilities:

1. **SuggestFollowupTask** - Propose follow-up tasks that can be executed in parallel sandboxes
2. **PermissionPrompt** - Internal permission handler for plan mode operations

## Installation

```bash
pnpm install @leo/mcp-server
```

## Usage

The server runs as a stdio process and can be integrated with MCP clients:

```bash
node dist/index.js
```

## Tools

### SuggestFollowupTask

- **Name**: `SuggestFollowupTask`
- **Description**: Suggest a follow-up task to the user
- **Input Schema**:
  - `title` (string, required): A concise title for the follow-up task
  - `description` (string, required): A detailed description of what the follow-up task entails
- **Returns**: Confirmation that the task suggestion was presented to the user

### PermissionPrompt

- **Purpose**: Internal permission handler for plan mode operations
- **Input**:
  - `tool_name` (string, required): The tool requesting permission
- **Returns**: JSON response with `behavior` and `message`
  - ExitPlanMode: `{"behavior": "deny", "message": "✏️ User is reviewing the change."}`
  - Other tools: Denied as unexpected
- **Note**: Used internally by Claude Code handling permission requests.

## Development

```bash
# Build the package
pnpm build

# Watch mode
pnpm dev

# Run the server
pnpm start
```

## MCP Integration

This server follows the Model Context Protocol specification and can be used with any MCP-compatible client. It uses stdio transport for communication.

## Testing with Claude Code

From this directory you can run:

```bash
# Test the SuggestFollowupTask tool
claude --mcp-config servers.json --allowedTools "mcp__terry__SuggestFollowupTask" --verbose --output-format stream-json -p "Create a test follow up task"

# Test the PermissionPrompt tool
claude --mcp-config servers.json --allowedTools "mcp__terry__PermissionPrompt" --verbose --output-format stream-json -p "Request permission for a test action"

# Test both tools
claude --mcp-config servers.json --allowedTools "mcp__terry__SuggestFollowupTask,mcp__terry__PermissionPrompt" --verbose --output-format stream-json -p "Test both tools"
```
