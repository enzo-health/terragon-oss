# Terry CLI

![](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square)

The official CLI for Terragon Labs - your AI-powered coding assistant.

## Installation

```bash
curl -fsSL https://terragon-lake.vercel.app/install-terry.sh | bash
```

This installer downloads the latest Terry CLI release from GitHub, installs its
runtime dependencies locally, and writes a `terry` launcher to
`~/.local/bin/terry` by default.

## Commands

### `terry auth`

Authenticate with your Terragon account. This will:

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

Create a new task in Terragon with a message:

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
terry create "Run large codegen" --model gpt-5.4-high
```

#### Options

- `-r, --repo <repo>`: GitHub repository (default: current repository)
- `-b, --branch <branch>`: Base branch name (default: current branch, falls back to main)
- `--no-new-branch`: Don't create a new branch (default: creates new branch)
- `-m, --mode <mode>`: Task mode: `plan` or `execute` (default: `execute`)
- `-M, --model <model>`: AI model to use: `opus`, `opus[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, `amp`, `gpt-5.4-low`, `gpt-5.4-medium`, `gpt-5.4`, `gpt-5.4-high`, `gpt-5.4-xhigh`, `gpt-5.4-mini-low`, `gpt-5.4-mini-medium`, `gpt-5.4-mini`, `gpt-5.4-mini-high`, `gpt-5.4-mini-xhigh`, `gpt-5.4-nano-low`, `gpt-5.4-nano-medium`, `gpt-5.4-nano`, `gpt-5.4-nano-high`, `gpt-5.4-nano-xhigh`, `gemini-3-pro`, `gemini-2.5-pro`, `grok-code`, `qwen3-coder`, `kimi-k2.5`, `glm-5.1`, `opencode/gemini-2.5-pro` (optional)

### `terry pull`

Pull tasks from Terragon to your local machine:

```bash
# Interactive mode - select from recent tasks
terry pull

# Pull a specific task by ID
terry pull <taskId>

# Pull and automatically launch Claude Code
terry pull <taskId> --resume
```

**Getting the task ID**: You can find the task ID at the end of the URL when viewing a task in Terragon. For example, in `https://terragonlabs.com/tasks/abc123-def456`, the task ID is `abc123-def456`.

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
Branch          terragon/fix-login
Repository      myorg/myrepo
PR Number       #123

Task ID         def789ghi012
Name            Add dark mode
Branch          terragon/dark-mode
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

You can add the Terry MCP server to your local Claude Code instance to enable direct interaction with Terragon tasks from within Claude:

```bash
claude mcp add terry -- terry mcp
```

This integration provides Claude Code with the following capabilities:

- **`terry_list`**: List all your Terragon tasks directly from Claude
- **`terry_create`**: Create new tasks without leaving Claude Code
- **`terry_pull`**: Pull task session data to continue work

The MCP server acts as a bridge between Claude Code and Terragon, allowing you to manage tasks using natural language commands within your AI coding sessions.

## Support

- **Documentation**: [https://docs.terragonlabs.com](https://docs.terragonlabs.com)
- **Website**: [https://terragonlabs.com](https://terragonlabs.com)
