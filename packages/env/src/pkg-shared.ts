import { defaultReporter, defaultReporterText, envsafe, str } from "envsafe";
import {
  devDefaultDatabaseUrl,
  devDefaultInternalSharedSecret,
} from "./common";

function isNextBuildProcess(): boolean {
  const argv = process.argv.join(" ");
  return argv.includes("next") && argv.includes("build");
}

function shouldSkipEnvValidation(): boolean {
  const skipValidation = process.env.SKIP_ENV_VALIDATION;
  if (skipValidation === "1" || skipValidation === "true") {
    return true;
  }
  return (
    process.env.NEXT_PHASE === "phase-production-build" || isNextBuildProcess()
  );
}

export const env = envsafe(
  {
    DATABASE_URL: str({
      devDefault: devDefaultDatabaseUrl,
    }),
    INTERNAL_SHARED_SECRET: str({
      devDefault: devDefaultInternalSharedSecret,
    }),
  },
  {
    reporter(opts) {
      if (shouldSkipEnvValidation()) {
        console.warn(defaultReporterText(opts));
        return;
      }
      defaultReporter(opts);
    },
  },
);
