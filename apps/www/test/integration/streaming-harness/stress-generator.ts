import type { BaseEvent } from "@ag-ui/core";
import {
  textStart,
  textContent,
  textEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  customRichPart,
} from "../ag-ui-replayer";

export type StressScenario = {
  name: string;
  events: BaseEvent[];
  expectedMessageCount: number;
};

export function singleMessageDeltas(count: number): StressScenario {
  const events: BaseEvent[] = [textStart("msg-1")];
  for (let i = 0; i < count; i++) {
    events.push(textContent("msg-1", `w${i} `));
  }
  events.push(textEnd("msg-1"));
  return { name: `single-${count}`, events, expectedMessageCount: 1 };
}

export function multiMessageDeltas(
  messageCount: number,
  deltasPerMessage: number,
): StressScenario {
  const events: BaseEvent[] = [];
  for (let m = 0; m < messageCount; m++) {
    const id = `msg-${m}`;
    events.push(textStart(id));
    for (let d = 0; d < deltasPerMessage; d++) {
      events.push(textContent(id, `w${d} `));
    }
    events.push(textEnd(id));
  }
  return {
    name: `multi-${messageCount}x${deltasPerMessage}`,
    events,
    expectedMessageCount: messageCount,
  };
}

export function interleavedToolCalls(
  toolCallCount: number,
  deltasPerGap: number,
): StressScenario {
  const events: BaseEvent[] = [textStart("msg-1")];
  events.push(textContent("msg-1", "Starting work. "));

  for (let t = 0; t < toolCallCount; t++) {
    const tcId = `tc-${t}`;
    events.push(toolCallStart(tcId, `tool_${t}`));
    events.push(toolCallArgs(tcId, `{"index":${t}}`));
    events.push(toolCallEnd(tcId));
    events.push(toolCallResult(tcId, `result-${t}`));

    for (let d = 0; d < deltasPerGap; d++) {
      events.push(textContent("msg-1", `r${t}d${d} `));
    }
  }

  events.push(textEnd("msg-1"));
  return {
    name: `tools-${toolCallCount}x${deltasPerGap}`,
    events,
    expectedMessageCount: 1,
  };
}

export function richPartBurst(partCount: number): StressScenario {
  const events: BaseEvent[] = [textStart("msg-1")];
  events.push(textContent("msg-1", "Delegating. "));

  for (let i = 0; i < partCount; i++) {
    events.push(
      customRichPart(
        "delegation",
        "msg-1",
        {
          type: "delegation",
          id: `del-${i}`,
          agentName: `agent-${i}`,
          message: `Task ${i}`,
          status: "running",
        },
        i,
      ),
    );
  }

  events.push(textEnd("msg-1"));
  return {
    name: `rich-${partCount}`,
    events,
    expectedMessageCount: 1,
  };
}
