import { beforeAll, describe, expect, it } from "vitest";

let runScheduledTasksCron: typeof import("./route").runScheduledTasksCron;

describe("scheduled-tasks cron route (VAL-API-008)", () => {
  beforeAll(async () => {
    ({ runScheduledTasksCron } = await import("./route"));
  });

  it("keeps scheduled task dispatch live", async () => {
    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true });
  });

  it("repeated watchdog ticks stay idempotent", async () => {
    const firstResponse = await runScheduledTasksCron();
    const secondResponse = await runScheduledTasksCron();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual(await secondResponse.json());
  });
});
