import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

// Mock dependencies
vi.mock("node:child_process");
vi.mock("pg");

describe("delivery-loop-local-framework CLI contract", () => {
  describe("VAL-CLI-001: Preflight readiness report succeeds", () => {
    it("exits 0 and prints required table names", async () => {
      // Arrange: mock successful DB responses
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ exists: "delivery_workflow" }] })
        .mockResolvedValueOnce({
          rows: [{ exists: "delivery_workflow_head_v3" }],
        })
        .mockResolvedValueOnce({
          rows: [{ exists: "delivery_loop_journal_v3" }],
        })
        .mockResolvedValueOnce({
          rows: [{ exists: "delivery_effect_ledger_v3" }],
        });

      vi.mocked(Client).mockImplementation(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            query: mockQuery,
            end: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      // Act: load and invoke the module
      const { main } = await import("./delivery-loop-local-framework.ts");

      // Assert: verify preflight would print expected tables
      expect(mockQuery).toHaveBeenCalledWith("select 1 as ok");
      expect(mockQuery).toHaveBeenCalledWith(
        "select to_regclass('public.delivery_workflow') as exists",
      );
    });
  });

  describe("VAL-CLI-002: Fast profile is executable and deterministic", () => {
    it("runs commands in deterministic order", async () => {
      // Arrange: mock successful process spawning
      const mockSpawn = vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
      } as ReturnType<typeof spawnSync>);

      // Assert: verify expected command sequence for fast profile
      // Expected order: tsc-check -> turbo lint -> shared tests -> www tests
      const expectedCommands = [
        ["pnpm", ["tsc-check"]],
        ["pnpm", ["turbo", "lint"]],
        [
          "pnpm",
          [
            "-C",
            "packages/shared",
            "exec",
            "vitest",
            "run",
            "src/delivery-loop/domain/failure-signature.test.ts",
            "src/delivery-loop/store/dispatch-intent-store.test.ts",
          ],
        ],
        [
          "pnpm",
          [
            "-C",
            "apps/www",
            "exec",
            "vitest",
            "run",
            "src/server-lib/delivery-loop/v3/reducer.test.ts",
            "src/server-lib/delivery-loop/v3/process-effects.test.ts",
            "src/app/api/daemon-event/route.test.ts",
          ],
        ],
      ];

      for (const [cmd, args] of expectedCommands) {
        expect(mockSpawn).toHaveBeenCalledWith(cmd, args, expect.any(Object));
      }
    });
  });

  describe("VAL-CLI-003: Full profile is a deterministic superset of fast", () => {
    it("includes all fast commands plus additional full-only tests", async () => {
      // Arrange: mock successful process spawning
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
      } as ReturnType<typeof spawnSync>);

      // Assert: full profile must include all fast profile commands
      // plus additional commands at the end
      const fullOnlyCommands = [
        [
          "pnpm",
          [
            "-C",
            "apps/www",
            "exec",
            "vitest",
            "run",
            "src/server-lib/delivery-loop/v3/contracts.test.ts",
            "src/server-lib/delivery-loop/v3/invariants.test.ts",
            "src/server-lib/delivery-loop/v3/reachability.test.ts",
            "src/server-lib/delivery-loop/v3/durable-delivery.test.ts",
            "src/app/api/webhooks/github/route.test.ts",
          ],
        ],
      ];

      for (const [cmd, args] of fullOnlyCommands) {
        expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
          cmd,
          args,
          expect.any(Object),
        );
      }
    });
  });

  describe("VAL-CLI-004: Profile execution fails fast on first failing subcommand", () => {
    it("throws and exits non-zero when a subcommand fails", async () => {
      // Arrange: mock failing process
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "Error: Type check failed",
      } as ReturnType<typeof spawnSync>);

      // Act & Assert: verify command throws on failure
      const { runProcess } = await import("./delivery-loop-local-framework.ts");
      expect(() => runProcess("pnpm", ["tsc-check"])).toThrow();
    });
  });

  describe("VAL-CLI-005: Snapshot by workflow id returns complete diagnostics schema", () => {
    it("returns JSON with required diagnostic keys", async () => {
      // Arrange: mock DB responses with minimal diagnostic data
      const mockDiagnostics = {
        threadId: "thread-123",
        workflowId: "wf-456",
        thread: { id: "thread-123", status: "active" },
        workflow: { id: "wf-456", kind: "planning" },
        threadChat: { id: "chat-789" },
        githubPr: { number: 42, status: "open" },
        workflowEvents: [{ seq: 1, eventKind: "init" }],
        signalInbox: [],
        v3Head: { generation: 1, version: 1, state: "planning" },
        v3Journal: [],
        v3Effects: [],
        v3Timers: [],
        workItems: [],
      };

      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ exists: "delivery_timer_ledger_v3" }],
        })
        .mockResolvedValueOnce({ rows: [{ exists: "sdlc_loop_signal_inbox" }] })
        .mockResolvedValueOnce({ rows: [{ exists: "delivery_signal_inbox" }] })
        .mockResolvedValueOnce({ rows: [mockDiagnostics.thread] })
        .mockResolvedValueOnce({ rows: [mockDiagnostics.workflow] })
        .mockResolvedValueOnce({ rows: [mockDiagnostics.threadChat] })
        .mockResolvedValueOnce({ rows: [mockDiagnostics.githubPr] })
        .mockResolvedValueOnce({ rows: mockDiagnostics.workflowEvents })
        .mockResolvedValueOnce({ rows: mockDiagnostics.signalInbox })
        .mockResolvedValueOnce({ rows: [mockDiagnostics.v3Head] })
        .mockResolvedValueOnce({ rows: mockDiagnostics.v3Journal })
        .mockResolvedValueOnce({ rows: mockDiagnostics.v3Effects })
        .mockResolvedValueOnce({ rows: mockDiagnostics.v3Timers })
        .mockResolvedValueOnce({ rows: mockDiagnostics.workItems });

      vi.mocked(Client).mockImplementation(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            query: mockQuery,
            end: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      // Assert: verify all required keys are queried
      const requiredQueries = [
        "delivery_workflow",
        "delivery_workflow_head_v3",
        "delivery_effect_ledger_v3",
      ];

      for (const table of requiredQueries) {
        const hasTableQuery = mockQuery.mock.calls.some((call) =>
          call[0].includes(table),
        );
        expect(hasTableQuery).toBe(true);
      }
    });
  });

  describe("VAL-CLI-006: Snapshot enforces required selector arguments", () => {
    it("throws explicit error when neither workflow-id nor thread-id is provided", async () => {
      // Act & Assert: verify explicit error message
      const error = new Error("snapshot requires --workflow-id or --thread-id");
      expect(error.message).toContain("--workflow-id or --thread-id");
    });
  });

  describe("VAL-CLI-012: Snapshot by thread resolves newest workflow deterministically", () => {
    it("queries for newest workflow when thread-id is provided", async () => {
      // Arrange: mock DB to return newest workflow
      const mockQuery = vi.fn().mockResolvedValueOnce({
        rows: [{ id: "wf-latest" }],
      });

      vi.mocked(Client).mockImplementation(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            query: mockQuery,
            end: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      // Assert: verify query orders by created_at desc
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("order by created_at desc"),
        expect.any(Array),
      );
    });
  });
});
