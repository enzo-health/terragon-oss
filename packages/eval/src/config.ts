import { resolve } from "path";

export const EVAL_ROOT = resolve(__dirname, "..");
export const FIXTURES_DIR = resolve(EVAL_ROOT, "fixtures");
export const RUNS_DIR = resolve(EVAL_ROOT, "runs");

export const PROD_DATABASE_URL =
  process.env.PROD_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:15432/postgres";
