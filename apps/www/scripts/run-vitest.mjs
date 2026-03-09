import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestCliPath = require.resolve("vitest/vitest.mjs");

const forwardedArgs = process.argv.slice(2);
const vitestArgs =
  forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

const result = spawnSync(
  process.execPath,
  [vitestCliPath, "run", ...vitestArgs],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
