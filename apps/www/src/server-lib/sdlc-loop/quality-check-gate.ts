import { ISandboxSession } from "@terragon/sandbox/types";

export type QualityCheckResult = {
  gatePassed: boolean;
  failures: string[];
};

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LENGTH = 2000;

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + "... (truncated)";
  }
  return output;
}

/**
 * Detects package manager, installs deps if missing, and runs
 * lint/typecheck/test commands in the sandbox. Returns structured
 * pass/fail result for the implementation quality gate.
 *
 * Works for ALL agents (Claude Code, Codex, Amp, Gemini, OpenCode).
 */
export async function runQualityCheckGateInSandbox(
  session: ISandboxSession,
): Promise<QualityCheckResult> {
  const cwd = session.repoDir;
  const failures: string[] = [];

  // Check if this is a JS/TS project
  const hasPackageJson = await session
    .runCommand("test -f package.json && echo yes", { cwd })
    .then((out) => out.trim() === "yes")
    .catch(() => false);

  if (!hasPackageJson) {
    return { gatePassed: true, failures: [] };
  }

  // Detect package manager
  const pm = await detectPackageManager(session, cwd);

  // Install deps if missing
  const hasNodeModules = await session
    .runCommand("test -d node_modules && echo yes", { cwd })
    .then((out) => out.trim() === "yes")
    .catch(() => false);

  if (!hasNodeModules) {
    try {
      await session.runCommand(`${pm} install`, {
        cwd,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      failures.push(
        `${pm} install failed: ${truncateOutput(error instanceof Error ? error.message : String(error))}`,
      );
      return { gatePassed: false, failures };
    }
  }

  // Get available scripts from package.json
  const availableScripts = await getAvailableScripts(session, cwd);

  // Group 1: Lint
  const lintScript = ["lint", "lint:fix"].find((s) =>
    availableScripts.includes(s),
  );
  if (lintScript) {
    const result = await runScript(session, pm, lintScript, cwd);
    if (!result.passed) {
      failures.push(
        `${pm} run ${lintScript} failed:\n${truncateOutput(result.output)}`,
      );
    }
  }

  // Group 2: Typecheck
  const typecheckScript = ["typecheck", "type-check", "tsc"].find((s) =>
    availableScripts.includes(s),
  );
  if (typecheckScript) {
    const result = await runScript(session, pm, typecheckScript, cwd);
    if (!result.passed) {
      failures.push(
        `${pm} run ${typecheckScript} failed:\n${truncateOutput(result.output)}`,
      );
    }
  }

  // Group 3: Test
  const testScript = ["test"].find((s) => availableScripts.includes(s));
  if (testScript) {
    const result = await runScript(session, pm, testScript, cwd);
    if (!result.passed) {
      failures.push(
        `${pm} run ${testScript} failed:\n${truncateOutput(result.output)}`,
      );
    }
  }

  return {
    gatePassed: failures.length === 0,
    failures,
  };
}

async function detectPackageManager(
  session: ISandboxSession,
  cwd: string,
): Promise<string> {
  const checks = [
    { file: "pnpm-lock.yaml", pm: "pnpm" },
    { file: "bun.lockb", pm: "bun" },
    { file: "bun.lock", pm: "bun" },
    { file: "yarn.lock", pm: "yarn" },
  ];

  for (const { file, pm } of checks) {
    const exists = await session
      .runCommand(`test -f ${file} && echo yes`, { cwd })
      .then((out) => out.trim() === "yes")
      .catch(() => false);
    if (exists) return pm;
  }
  return "npm";
}

async function getAvailableScripts(
  session: ISandboxSession,
  cwd: string,
): Promise<string[]> {
  try {
    const output = await session.runCommand(
      `node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).join(','))"`,
      { cwd },
    );
    return output
      .trim()
      .split(",")
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

async function runScript(
  session: ISandboxSession,
  pm: string,
  script: string,
  cwd: string,
): Promise<{ passed: boolean; output: string }> {
  try {
    const output = await session.runCommand(`${pm} run ${script}`, {
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return { passed: true, output };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return { passed: false, output };
  }
}
