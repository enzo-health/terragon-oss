import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  const abs = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    relativePath,
  );
  return fs.readFileSync(abs, "utf-8");
}

describe("AG-UI WebSocket revert — regression guards", () => {
  it("featureFlagsDefinitions does not contain aguiWebSocket", async () => {
    const { featureFlagsDefinitions } = await import(
      "@terragon/shared/model/feature-flags-definitions"
    );
    expect(Object.keys(featureFlagsDefinitions)).not.toContain("aguiWebSocket");
  });

  it("useAgUiTransport has no WebSocket/PartyKit/featureFlag/bearerToken references", () => {
    const src = readSource("apps/www/src/hooks/use-ag-ui-transport.ts");
    const forbidden = [
      "WebSocketAgent",
      "WebSocket",
      "PartySocket",
      "partykit",
      "useFeatureFlag",
      "bearerToken",
      "publicBroadcastHost",
    ];
    for (const term of forbidden) {
      expect(src).not.toContain(term);
    }
  });

  it("ag-ui-publisher has no PartyKit broadcast references", () => {
    const src = readSource("apps/www/src/server-lib/ag-ui-publisher.ts");
    const forbidden = [
      "publishToPartyKit",
      "publishAgUiToPartyKit",
      "PartyKit",
      "partykit",
      "/parties/agui/",
    ];
    for (const term of forbidden) {
      expect(src).not.toContain(term);
    }
  });

  it("partykit.json does not register an agui party", () => {
    const src = readSource("apps/broadcast/partykit.json");
    const config = JSON.parse(src);
    const partyNames = Object.keys(config.parties ?? {});
    expect(partyNames).not.toContain("agui");
  });

  it("websocket-agent.ts does not exist", () => {
    const candidate = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "lib",
      "websocket-agent.ts",
    );
    expect(fs.existsSync(candidate)).toBe(false);
  });
});
