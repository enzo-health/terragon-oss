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
// Also handles flags before the filter: `pnpm test -- --coverage src/foo.test.ts`.
const hasSubcommand =
  vitestArgs.length > 0 && vitestSubcommands.has(vitestArgs[0]);
const firstArgIsFilter =
  vitestArgs.length > 0 &&
  !vitestArgs[0]?.startsWith("-") &&
  !vitestSubcommands.has(vitestArgs[0]);
// Also detect file paths that appear after leading flags (e.g. `--coverage src/foo.test.ts`)
const hasLatePositionalFilter =
  !hasSubcommand &&
  !firstArgIsFilter &&
  vitestArgs.some(
    (arg) =>
      !arg.startsWith("-") &&
      (arg.includes("/") || /\.(?:test|spec)\b/.test(arg)),
  );
const shouldForceRun = firstArgIsFilter || hasLatePositionalFilter;

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
