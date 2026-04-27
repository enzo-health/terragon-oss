import { beforeAll, describe, expect, it } from "vitest";

let runScheduledTasksCron: typeof import("./route").runScheduledTasksCron;

describe("scheduled-tasks cron route (VAL-API-008)", () => {
  beforeAll(async () => {
    ({ runScheduledTasksCron } = await import("./route"));
  });

  it("keeps scheduled task dispatch live while delivery-loop drainers are quiesced", async () => {
    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      deliveryLoopDrainers: "quiesced",
      v3OutboxWorkerProcessed: 0,
      v3OutboxWorkerAcknowledged: 0,
      v3OutboxWorkerDeadLettered: 0,
      v3OutboxWorkerRetried: 0,
      v3EffectsProcessed: 0,
      v3OutboxProcessed: 0,
      v3OutboxPublished: 0,
      v3OutboxFailed: 0,
      v3ZombieHeadsScanned: 0,
      v3ZombieHeadsReconciled: 0,
    });
  });

  it("repeated watchdog ticks stay idempotent while delivery-loop drainers are quiesced", async () => {
    const firstResponse = await runScheduledTasksCron();
    const secondResponse = await runScheduledTasksCron();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual(await secondResponse.json());
  });
});
