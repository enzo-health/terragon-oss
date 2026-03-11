import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestCliPath = require.resolve("vitest/vitest.mjs");
const vitestSubcommands = new Set([
  "run",
  "related",
  "watch",
  "dev",
  "bench",
  "init",
  "list",
]);

const forwardedArgs = process.argv.slice(2);
const vitestArgs =
  forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
// Preserve plain `pnpm test` Vitest behavior, but keep positional file filters in
// one-shot mode for PR verification commands like `pnpm test -- path/to/file.test.ts`.
// Find the first positional (non-flag) argument anywhere in vitestArgs.
const firstPositionalArg = vitestArgs.find((arg) => !arg.startsWith("-"));
const hasExplicitSubcommand =
  firstPositionalArg != null && vitestSubcommands.has(firstPositionalArg);
const firstArgIsPositional =
  firstPositionalArg != null && !hasExplicitSubcommand;
// Also detect test file targets after leading flags (e.g. `-- --coverage src/foo.test.ts`)
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$/;
const hasTestFileArg =
  !firstArgIsPositional &&
  !hasExplicitSubcommand &&
  vitestArgs.some((arg) => !arg.startsWith("-") && TEST_FILE_RE.test(arg));
const shouldForceRun = firstArgIsPositional || hasTestFileArg;

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
