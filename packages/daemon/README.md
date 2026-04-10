# Leo Daemon

A daemon service that listens to a unix socket to orchestrate Agent running locally on the sandbox.

## Overview

The Leo Daemon creates a unix socket at `/tmp/leo-daemon.sock` and listens for JSON messages containing configuration for Agent interactions. At a high-level, the daemon controls how to spawn a Agent process with the provided prompt and configuration and forwards the output to a specified API endpoint.

## Usage

### Starting the Daemon

```bash
# Build the daemon
pnpm build

# Start with default settings (server at http://localhost:3000)
./dist/index.js

# Start with custom server URL
./dist/index.js --url https://your-server.com
```

### Sending Messages

Send JSON messages to the daemon to trigger Agent interactions:

```bash
echo '{"type":"ping"}' | ./dist/index.js --write
```

See: `DaemonMessageSchema` in `src/shared.ts` for the schema of supported messages.

## Command Line Options

- `-u, --url <url>`: Server URL (default: `http://localhost:3000`)
- `-h, --help`: Show help message

## API Endpoint

The daemon sends Claude's output to `POST /api/daemon-event` with:

- Header: `X-Daemon-Token: <token>`
- Body: Array of Claude output messages

## Architecture

1. **Startup**: Daemon creates unix socket and starts listening
2. **Message Received**: JSON message parsed and validated
3. **Message Processing**:
   - `claude`: Spawns Agent process (kills any existing process first). NOTE: This is named claude but is used to spawn different agents beyond just Claude.
   - `stop`: Kills active Claude process for the specified thread
   - `kill`: Terminates the daemon entirely
4. **Output Processing**: Agent output is buffered, pre-processed and sent to API endpoint
5. **Process Management**: Single active Agent process with proper cleanup
6. **Cleanup**: Process completes and daemon continues listening

## Error Handling

- Invalid JSON messages are logged and ignored
- Missing required fields trigger error messages
- Network failures are logged but don't stop the daemon
- Process termination errors are caught and logged
- The daemon automatically recreates the unix socket if needed
- Graceful shutdown with proper cleanup of active processes

### Idle Watchdog

- Agent runs are monitored for inactivity. If an agent produces no output for 5 minutes, the daemon kills the agent process and reports an error back to the API.
- Configure the timeout via `IDLE_TIMEOUT_MS` (milliseconds). Default: `300000`.

## Logging

The daemon provides detailed logging including:

- Heartbeat every 5 seconds showing uptime
- Received messages and validation status
- API calls and their results
- ❌ Errors and warnings
