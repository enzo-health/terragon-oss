# Terry CLI

![](https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat-square) [![npm]](https://www.npmjs.com/package/@leo-labs/cli)

[npm]: https://img.shields.io/npm/v/@leo-labs/cli.svg?style=flat-square

The official CLI for Leo Labs - your AI-powered coding assistant.

## Installation

```bash
# Using npm
npm install -g @leo-labs/cli

# Using pnpm
pnpm add -g @leo-labs/cli

# Using yarn
yarn global add @leo-labs/cli
```

## Commands

### `terry auth`

Authenticate with your Leo account. This will:

1. Open your browser for authentication
2. Generate a secure token
3. Store credentials safely in `~/.terry/config.json` (configurable via `TERRY_SETTINGS_DIR`)
4. Confirm successful connection

```bash
terry auth
```

#### Configuration directory

By default, credentials are stored in `~/.terry/config.json`. You can override the settings directory by setting the `TERRY_SETTINGS_DIR` environment variable:

```bash
# Example: use a custom settings directory
export TERRY_SETTINGS_DIR=~/.config/terry
terry auth
```

### `terry create`

Create a new task in Leo with a message:

```bash
# Create a task in the current repository and branch
terry create "Fix the login bug"

# Specify a different repository
terry create "Add new feature" --repo owner/repo

# Use a specific base branch
terry create "Update documentation" --branch develop

# Use existing branch without creating a new one
terry create "Quick fix" --no-new-branch

# Start in plan mode (no file writes until approval)
terry create "Refactor the auth module" --mode plan

# Choose a specific model
terry create "Investigate flaky tests" --model sonnet
terry create "Run large codegen" --model gpt-5-high
> GPT-5.1 Codex Max variants require a ChatGPT subscription connected in Settings.
```

#### Options

- `-r, --repo <repo>`: GitHub repository (default: current repository)
- `-b, --branch <branch>`: Base branch name (default: current branch, falls back to main)
- `--no-new-branch`: Don't create a new branch (default: creates new branch)
- `-m, --mode <mode>`: Task mode: `plan` or `execute` (default: `execute`)
- `-M, --model <model>`: AI model to use: `opus`, `sonnet`, `haiku`, `amp`, `gpt-5-low`, `gpt-5-medium`, `gpt-5`, `gpt-5-high`, `gpt-5.2-low`, `gpt-5.2-medium`, `gpt-5.2`, `gpt-5.2-high`, `gpt-5.1-low`, `gpt-5.1-medium`, `gpt-5.1`, `gpt-5.1-high`, `gpt-5.1-codex-max-low`, `gpt-5.1-codex-max-medium`, `gpt-5.1-codex-max`, `gpt-5.1-codex-max-high`, `gpt-5.1-codex-max-xhigh`, `gpt-5-codex-low`, `gpt-5-codex-medium`, `gpt-5-codex-high`, `gpt-5.1-codex-low`, `gpt-5.1-codex-medium`, `gpt-5.1-codex-high`, `gemini-3-pro`, `gemini-2.5-pro`, `grok-code`, `qwen3-coder`, `kimi-k2`, `glm-4.6`, `opencode/gemini-2.5-pro` (optional)

### `terry pull`

Pull tasks from Leo to your local machine:

```bash
# Interactive mode - select from recent tasks
terry pull

# Pull a specific task by ID
terry pull <taskId>

# Pull and automatically launch Claude Code
terry pull <taskId> --resume
```

**Getting the task ID**: You can find the task ID at the end of the URL when viewing a task in Leo. For example, in `https://terragonlabs.com/tasks/abc123-def456`, the task ID is `abc123-def456`.

#### Options

- `-r, --resume`: Automatically launch Claude Code after pulling

### `terry list`

List all tasks in a non-interactive format:

```bash
# List all tasks (automatically filters by current repo when inside a Git repository)
terry list
```

#### Example Output

```
Task ID         abc123def456
Name            Fix login bug
Branch          leo/fix-login
Repository      myorg/myrepo
PR Number       #123

Task ID         def789ghi012
Name            Add dark mode
Branch          leo/dark-mode
Repository      myorg/myrepo
PR Number       N/A

Total: 2 tasks
```

### `terry mcp`

Run an MCP (Model Context Protocol) server for the git repository:

```bash
# Run MCP server for current directory
terry mcp
```

#### Claude Code Integration

You can add the Terry MCP server to your local Claude Code instance to enable direct interaction with Leo tasks from within Claude:

```bash
claude mcp add terry -- terry mcp
```

This integration provides Claude Code with the following capabilities:

- **`terry_list`**: List all your Leo tasks directly from Claude
- **`terry_create`**: Create new tasks without leaving Claude Code
- **`terry_pull`**: Pull task session data to continue work

The MCP server acts as a bridge between Claude Code and Leo, allowing you to manage tasks using natural language commands within your AI coding sessions.

## Support

- **Documentation**: [https://docs.terragonlabs.com](https://docs.terragonlabs.com)
- **Website**: [https://terragonlabs.com](https://terragonlabs.com)
