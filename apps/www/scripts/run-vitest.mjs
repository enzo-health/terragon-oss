import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestCliPath = require.resolve("vitest/vitest.mjs");
const vitestSubcommands = new Set(["run", "watch", "dev", "bench", "list"]);

const forwardedArgs = process.argv.slice(2);
const vitestArgs =
  forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
// Preserve plain `pnpm test` Vitest behavior, but keep positional file filters in
// one-shot mode for PR verification commands like `pnpm test -- path/to/file.test.ts`.
const shouldForceRun =
  vitestArgs.length > 0 &&
  !vitestArgs[0]?.startsWith("-") &&
  !vitestSubcommands.has(vitestArgs[0]);

const result = spawnSync(
  process.execPath,
  [vitestCliPath, ...(shouldForceRun ? ["run"] : []), ...vitestArgs],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
