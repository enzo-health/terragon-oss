/**
 * Partykit dev is a react ink cli and that interacts poorly with concurrently.
 * This script runs the partykit dev command and pipes the output to the console.
 * It also cleans the output to remove ansi escape codes and multiple newlines to
 * play nicely with concurrently.
 */
import stripAnsi from "strip-ansi";
import childProcess from "child_process";

const devDefaultAppUrl = "http://localhost:3000";
const devDefaultInternalSharedSecret = "123456";

function cleanLine(line: string) {
  line = stripAnsi(line);
  line = line.trim();
  line = line.replace(/\n+/g, "\n");
  return line;
}

function main() {
  const child = childProcess.spawn("pnpm", ["partykit", "dev"], {
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      INTERNAL_SHARED_SECRET:
        process.env.INTERNAL_SHARED_SECRET ?? devDefaultInternalSharedSecret,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? devDefaultAppUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    console.log(cleanLine(data.toString()));
  });

  child.stderr.on("data", (data) => {
    console.error(cleanLine(data.toString()));
  });

  child.on("exit", (code) => {
    process.exit(code);
  });
}

main();
