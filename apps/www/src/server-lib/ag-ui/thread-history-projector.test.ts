import { describe, test, expect } from "vitest";

describe("thread-history-projector", () => {
  test("placeholder: module imports cleanly", async () => {
    const mod = await import("@/server-lib/ag-ui/thread-history-projector");
    expect(mod.projectThreadHistory).toBeDefined();
    expect(mod.ThreadHistoryProjection).toBeUndefined(); // type-only export
  });
});
