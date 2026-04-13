import { defineConfig } from "tsup";
import { config } from "dotenv";

// Load environment variables from .env files
config();

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node20",
  clean: true,
  shims: true,
  bundle: true,
  noExternal: ["@terragon/cli-api-contract"],
  define: {
    "process.env.TERRAGON_WEB_URL": JSON.stringify(
      process.env.TERRAGON_WEB_URL || "https://terragon-lake.vercel.app",
    ),
    "process.env.TERRY_NO_AUTO_UPDATE": JSON.stringify(
      process.env.TERRY_NO_AUTO_UPDATE || "0",
    ),
  },
});
