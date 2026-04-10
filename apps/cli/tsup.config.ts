import { defineConfig } from "tsup";
import { config } from "dotenv";

// Load environment variables from .env files
config();

const webUrl =
  process.env.LEO_WEB_URL ||
  process.env.TERRAGON_WEB_URL ||
  "https://www.terragonlabs.com";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node20",
  clean: true,
  shims: true,
  bundle: true,
  noExternal: ["@leo/cli-api-contract"],
  define: {
    "process.env.LEO_WEB_URL": JSON.stringify(webUrl),
    "process.env.TERRAGON_WEB_URL": JSON.stringify(webUrl),
    "process.env.TERRY_NO_AUTO_UPDATE": JSON.stringify(
      process.env.TERRY_NO_AUTO_UPDATE || "0",
    ),
  },
});
