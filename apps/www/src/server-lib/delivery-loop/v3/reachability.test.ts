import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { WorkflowHead } from "./types";
import {
  ALL_CANONICAL_EVENTS,
  ALL_STATES,
  BRANCH_CASES,
  CONTRACT_NOW,
  EXPECTED_TRANSITIONS,
  NON_TERMINAL_STATES,
  TERMINAL_STATES,
  makeContractHead,
} from "./transition-contract";

type ContractWorkflowState = (typeof ALL_STATES)[number];

function canReachTerminal(startState: (typeof NON_TERMINAL_STATES)[number]): {
  reachable: boolean;
  path: string[];
} {
  const queue: { head: WorkflowHead; path: string[] }[] = [
    { head: makeContractHead(startState), path: [startState] },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { head, path } = queue.shift()!;
    if (TERMINAL_STATES.has(head.state)) return { reachable: true, path };
    if (visited.has(head.state)) continue;
    visited.add(head.state);
    const currentState = head.state as ContractWorkflowState;

    for (const event of ALL_CANONICAL_EVENTS) {
      const result = reduce({
        head: makeContractHead(currentState),
        event,
        now: CONTRACT_NOW,
      });
      if (result.head.state !== head.state) {
        queue.push({
          head: result.head,
          path: [...path, `--${event.type}-->`, result.head.state],
        });
      }
    }
  }
  return { reachable: false, path: [] };
}

describe("BFS reachability", () => {
  for (const state of NON_TERMINAL_STATES) {
    it(`${state} can reach a terminal state`, () => {
      const result = canReachTerminal(state);
      expect(result.reachable).toBe(true);
    });
  }
});

describe("terminal state absorption", () => {
  for (const state of ["done", "stopped", "terminated"] as const) {
    it(`${state} absorbs all events except workflow_resurrected`, () => {
      for (const event of ALL_CANONICAL_EVENTS) {
        const result = reduce({
          head: makeContractHead(state),
          event,
          now: CONTRACT_NOW,
        });
        // workflow_resurrected is the one intentional escape hatch — it
        // takes terminal workflows back to implementing so the agent can
        // triage a new GitHub event on the shipped PR.
        if (event.type === "workflow_resurrected") {
          expect(result.head.state).toBe("implementing");
        } else {
          expect(result.head.state).toBe(state);
        }
      }
    });
  }

  for (const state of ["done", "stopped", "terminated"] as const) {
    it(`${state} resurrects to implementing with reset retry budgets`, () => {
      const head = makeContractHead(state);
      const result = reduce({
        head: { ...head, fixAttemptCount: 5, infraRetryCount: 3 },
        event: {
          type: "workflow_resurrected",
          reason: "test",
          cause: "check_failure",
        },
        now: CONTRACT_NOW,
      });
      expect(result.head.state).toBe("implementing");
      expect(result.head.fixAttemptCount).toBe(0);
      expect(result.head.infraRetryCount).toBe(0);
      expect(result.head.narrationOnlyRetryCount).toBe(0);
      expect(result.head.blockedReason).toBeNull();
      expect(result.head.activeGate).toBeNull();
      expect(result.effects.map((e) => e.kind)).toContain(
        "dispatch_implementing",
      );
      expect(result.effects.map((e) => e.kind)).toContain("publish_status");
    });
  }
});

describe("workflow_resurrected on non-terminal states", () => {
  for (const state of [
    "planning",
    "implementing",
    "gating_review",
    "gating_ci",
    "awaiting_pr_creation",
    "awaiting_pr_lifecycle",
    "awaiting_manual_fix",
    "awaiting_operator_action",
  ] as const) {
    it(`${state} ignores workflow_resurrected (no-op)`, () => {
      const head = makeContractHead(state);
      const result = reduce({
        head,
        event: {
          type: "workflow_resurrected",
          reason: "test",
          cause: "pr_comment",
        },
        now: CONTRACT_NOW,
      });
      expect(result.head.state).toBe(state);
      expect(result.head.version).toBe(head.version);
      expect(result.effects).toEqual([]);
    });
  }
});

describe("exhaustive (state x event) transition table", () => {
  for (const state of ALL_STATES) {
    describe(state, () => {
      const expectations = EXPECTED_TRANSITIONS[state]!;
      for (const event of ALL_CANONICAL_EVENTS) {
        const cell = expectations[event.type]!;
        it(`${event.type} -> ${cell.target}`, () => {
          const head = makeContractHead(state);
          const result = reduce({ head, event, now: CONTRACT_NOW });

          if (cell.target === "noop") {
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBe(head.version);
          } else if (cell.target === "stay") {
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBeGreaterThan(head.version);
          } else {
            expect(result.head.state).toBe(cell.target);
          }

          expect(result.effects.map((effect) => effect.kind)).toEqual(
            cell.effects ?? [],
          );
        });
      }
    });
  }
});

describe("branch-sensitive transition contracts", () => {
  for (const testCase of BRANCH_CASES) {
    it(testCase.name, () => {
      const result = reduce({
        head: testCase.head,
        event: testCase.event,
        now: CONTRACT_NOW,
      });
      expect(result.head.state).toBe(testCase.expectedState);
      if (testCase.expectedVersionDelta === 0) {
        expect(result.head.version).toBe(testCase.head.version);
      } else {
        expect(result.head.version).toBeGreaterThan(testCase.head.version);
      }
      expect(result.effects.map((effect) => effect.kind)).toEqual(
        testCase.expectedEffects,
      );
    });
  }
});
