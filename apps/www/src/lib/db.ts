import { createDb } from "@leo/shared/db";
import { env } from "@leo/env/apps-www";

export const db = createDb(env.DATABASE_URL);
