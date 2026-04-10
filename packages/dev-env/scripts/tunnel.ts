import * as ngrok from "@ngrok/ngrok";
import { env } from "@leo/env/pkg-dev-env";
import { spawn } from "child_process";

let isShuttingDown = false;
let currentListener: Awaited<ReturnType<typeof ngrok.forward>> | null = null;
let customTunnelProcess: ReturnType<typeof spawn> | null = null;
let restartCount = 0;
const MAX_RESTART_DELAY = 30000; // 30 seconds
const INITIAL_RESTART_DELAY = 1000; // 1 second

async function createTunnel() {
  try {
    const listener = await ngrok.forward({
      addr: env.WWW_PORT ?? 3000,
      domain: env.NGROK_DOMAIN,
      authtoken: env.NGROK_AUTH_TOKEN,
      onStatusChange: (status) => {
        console.log(
          `[${new Date().toISOString()}] Tunnel status changed: ${status}`,
        );
        // Handle disconnection
        if (
          (status === "closed" || status === "disconnected") &&
          !isShuttingDown
        ) {
          console.log(
            `[${new Date().toISOString()}] Tunnel disconnected, scheduling restart...`,
          );
          setTimeout(() => restartTunnel(), 100);
        }
      },
    });
    console.log(
      `[${new Date().toISOString()}] NGROK tunnel established at: ${listener.url()}`,
    );
    restartCount = 0; // Reset restart count on successful connection
    return listener;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to create tunnel:`,
      error,
    );
    throw error;
  }
}

async function startCustomTunnel() {
  try {
    console.log(
      `[${new Date().toISOString()}] Starting custom tunnel command: ${env.CUSTOM_TUNNEL_COMMAND}`,
    );
    const process = spawn(env.CUSTOM_TUNNEL_COMMAND, {
      shell: true,
      stdio: "inherit",
    });
    process.on("exit", (code) => {
      console.log(
        `[${new Date().toISOString()}] Custom tunnel process exited with code ${code}`,
      );
      if (!isShuttingDown) {
        console.log(
          `[${new Date().toISOString()}] Custom tunnel disconnected, scheduling restart...`,
        );
        setTimeout(() => restartTunnel(), 100);
      }
    });
    process.on("error", (error) => {
      console.error(
        `[${new Date().toISOString()}] Custom tunnel process error:`,
        error,
      );
    });
    restartCount = 0;
    return process;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to start custom tunnel:`,
      error,
    );
    throw error;
  }
}

async function closeTunnel() {
  if (customTunnelProcess) {
    try {
      customTunnelProcess.kill();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error closing custom tunnel:`,
        error,
      );
    }
    customTunnelProcess = null;
  }
  if (currentListener) {
    try {
      await currentListener.close();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error closing existing tunnel:`,
        error,
      );
    }
    currentListener = null;
  }
}

async function restartTunnel() {
  if (isShuttingDown) {
    return;
  }
  console.log(
    `[${new Date().toISOString()}] Restarting tunnel (attempt ${restartCount + 1})...`,
  );
  await closeTunnel();
  const delay = Math.min(
    INITIAL_RESTART_DELAY * Math.pow(2, restartCount),
    MAX_RESTART_DELAY,
  );
  restartCount++;
  await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    if (env.CUSTOM_TUNNEL_COMMAND) {
      customTunnelProcess = await startCustomTunnel();
    } else {
      currentListener = await createTunnel();
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to restart tunnel:`,
      error,
    );
    setTimeout(() => restartTunnel(), delay);
  }
}

async function main() {
  try {
    if (env.CUSTOM_TUNNEL_COMMAND) {
      customTunnelProcess = await startCustomTunnel();
    } else {
      currentListener = await createTunnel();
    }
    const cleanup = async () => {
      isShuttingDown = true;
      await closeTunnel();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGHUP", cleanup);
    process.stdin.resume();
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Initial tunnel creation failed:`,
      error,
    );
    setTimeout(() => restartTunnel(), INITIAL_RESTART_DELAY);
    process.stdin.resume();
  }
}

// Handle uncaught exceptions to prevent process crash
process.on("uncaughtException", (error) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, error);
  if (!isShuttingDown) {
    restartTunnel();
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    `[${new Date().toISOString()}] Unhandled rejection at:`,
    promise,
    "reason:",
    reason,
  );
  if (!isShuttingDown) {
    restartTunnel();
  }
});

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, err);
  process.exit(1);
});
