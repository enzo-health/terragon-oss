import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(packageDir, "..", "..", "..");
let didLoadMonorepoEnvFiles = false;

export function loadMonorepoEnvFiles({
  appRelativeDir,
}: {
  appRelativeDir?: string;
}) {
  if (didLoadMonorepoEnvFiles) {
    return;
  }

  const envFiles = [
    appRelativeDir ? path.join(repoRoot, appRelativeDir, ".env.local") : null,
    appRelativeDir
      ? path.join(repoRoot, appRelativeDir, ".env.development.local")
      : null,
    appRelativeDir
      ? path.join(repoRoot, appRelativeDir, ".env.production.local")
      : null,
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.development.local"),
    path.join(repoRoot, ".env.production.local"),
  ];

  for (const envPath of envFiles) {
    if (!envPath) {
      continue;
    }
    if (fs.existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }

  didLoadMonorepoEnvFiles = true;
}
