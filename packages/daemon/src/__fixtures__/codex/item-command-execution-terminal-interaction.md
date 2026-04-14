# Codex fixture: item-command-execution-terminal-interaction — SYNTHESIZED

## Source

Synthesized from Codex app-server protocol specification. Represents the `item/commandExecution/terminalInteraction` notification for interactive terminal events.

## Fields

- `jsonrpc`: "2.0" — JSON-RPC version
- `method`: "item/commandExecution/terminalInteraction" — notification method type
- `params.threadId`: Codex thread ID (UUID v7 format)
- `params.turnId`: Turn identifier
- `params.itemId`: Identifier of the command execution item
- `params.interaction.type`: Interaction type ("input" | "output")
- `params.interaction.content`: Text content of the interaction (prompt or input line)

## How to re-capture live

1. Send a prompt that triggers an interactive command requiring user input
2. Observe Codex app-server output as the command prompts for input
3. Capture the `item/commandExecution/terminalInteraction` notification
4. Verify `interaction.type` and `interaction.content` match the terminal event
