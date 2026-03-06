import { readFileSync } from "fs";
import { join } from "path";
import { env } from "@terragon/env/apps-www";

export async function GET() {
  const scriptPath = join(
    process.cwd(),
    "../../packages/mac-mini-setup/setup.sh",
  );
  const scriptTemplate = readFileSync(scriptPath, "utf-8");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || env.BETTER_AUTH_URL;
  const script = scriptTemplate.replaceAll("__TERRAGON_APP_URL__", appUrl);
  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "inline; filename=setup.sh",
    },
  });
}
