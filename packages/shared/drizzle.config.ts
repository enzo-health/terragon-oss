import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(packageDir, "..", "..");

function loadLocalEnvFiles() {
  const envFiles = [
    path.join(packageDir, ".env.local"),
    path.join(packageDir, ".env.development.local"),
    path.join(packageDir, ".env.production.local"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.development.local"),
    path.join(repoRoot, ".env.production.local"),
  ];

  for (const envPath of envFiles) {
    if (fs.existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }
}

loadLocalEnvFiles();

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for drizzle-kit");
  }
  return databaseUrl;
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
});
