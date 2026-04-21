# Cline Sub-Agent Pattern: Full Trace

**Document**: Deep-dive reverse engineering of Cline's sub-agent spawning, execution, and UI rendering architecture.

**Scope**: End-to-end from tool invocation (backend) → wire format → state management → React rendering in VSCode WebView.

---

## Table of Contents

1. [Part 1: Backend Emission (How Sub-Agents Are Spawned)](#part-1--backend-emission)
2. [Part 2: Wire Format (Message Shape & Routing)](#part-2--wire-format)
3. [Part 3: Client-Side State (How UI Tracks Sub-Agents)](#part-3--client-side-state)
4. [Part 4: Rendering (Full Component Code & Styling)](#part-4--rendering)
5. [Part 5: Stop/Cancel Behavior](#part-5--stopcancl-behavior)
6. [Part 6: Adaptation for Terragon](#part-6--adaptation-for-terragon)

---

## Part 1: Backend Emission

### Where the Sub-Agent is Spawned

**File**: `/src/core/task/tools/handlers/SubagentToolHandler.ts`

The `UseSubagentsToolHandler` class implements the `IFullyManagedTool` interface. When Claude calls the `use_subagents` tool, this handler is invoked via `execute()`:

```typescript
export class UseSubagentsToolHandler implements IFullyManagedTool {
  readonly name = ClineDefaultTool.USE_SUBAGENTS;

  getDescription(_block: ToolUse): string {
    const configuredSubagentName = resolveConfiguredSubagentName(_block.name);
    return configuredSubagentName
      ? `[subagent: ${configuredSubagentName}]`
      : "[subagents]";
  }

  async handlePartialBlock(
    block: ToolUse,
    uiHelpers: StronglyTypedUIHelpers,
  ): Promise<void> {
    const configuredSubagentName = resolveConfiguredSubagentName(block.name);
    const prompts = configuredSubagentName
      ? [
          uiHelpers
            .removeClosingTag(
              block,
              "prompt",
              block.params.prompt?.trim() || block.params.prompt_1?.trim(),
            )
            ?.trim(),
        ].filter((prompt): prompt is string => !!prompt)
      : PROMPT_KEYS.map((key) =>
          uiHelpers.removeClosingTag(block, key, block.params[key]?.trim()),
        )
          .map((prompt) => prompt?.trim())
          .filter((prompt): prompt is string => !!prompt);

    if (prompts.length === 0) {
      return;
    }

    const partialMessage = JSON.stringify({
      prompts,
    } satisfies ClineAskUseSubagents);
    const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name);
    const [shouldAutoApprove] = Array.isArray(autoApproveResult)
      ? autoApproveResult
      : [autoApproveResult, false];

    if (shouldAutoApprove) {
      await uiHelpers.removeLastPartialMessageIfExistsWithType(
        "ask",
        "use_subagents",
      );
      await uiHelpers.say(
        "use_subagents",
        partialMessage,
        undefined,
        undefined,
        block.partial,
      );
    } else {
      await uiHelpers.removeLastPartialMessageIfExistsWithType(
        "say",
        "use_subagents",
      );
      await uiHelpers
        .ask("use_subagents", partialMessage, block.partial)
        .catch(() => {});
    }
  }

  async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
    const subagentsEnabled =
      config.services.stateManager.getGlobalSettingsKey("subagentsEnabled");
    if (!subagentsEnabled) {
      return formatResponse.toolError(
        "Subagents are disabled. Enable them in Settings > Features to use this tool.",
      );
    }

    const configuredSubagentName = resolveConfiguredSubagentName(block.name);
    const prompts = collectPrompts(block, configuredSubagentName);

    if (prompts.length === 0) {
      config.taskState.consecutiveMistakeCount++;
      return await config.callbacks.sayAndCreateMissingParamError(
        this.name,
        configuredSubagentName ? "prompt" : "prompt_1",
      );
    }

    if (!configuredSubagentName && prompts.length > MAX_SUBAGENT_PROMPTS) {
      config.taskState.consecutiveMistakeCount++;
      return formatResponse.toolError(
        `Too many subagent prompts provided (${prompts.length}). Maximum is ${MAX_SUBAGENT_PROMPTS}.`,
      );
    }

    const apiConfig = config.services.stateManager.getApiConfiguration();
    const currentMode =
      config.services.stateManager.getGlobalSettingsKey("mode");
    const provider = (
      currentMode === "plan"
        ? apiConfig.planModeApiProvider
        : apiConfig.actModeApiProvider
    ) as string;
    const approvalPayload: ClineAskUseSubagents = { prompts };
    const approvalBody = JSON.stringify(approvalPayload);

    const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(
      this.name,
    );
    const [autoApproveSafe] = Array.isArray(autoApproveResult)
      ? autoApproveResult
      : [autoApproveResult, false];
    const didAutoApprove = !!autoApproveSafe;

    if (didAutoApprove) {
      telemetryService.captureToolUsage(
        config.ulid,
        this.name,
        config.api.getModel().id,
        provider,
        true,
        true,
        undefined,
        block.isNativeToolCall,
      );
    } else {
      showNotificationForApproval(
        prompts.length === 1
          ? `Cline wants to use ${configuredSubagentName ? `the '${configuredSubagentName}' subagent` : "a subagent"}`
          : `Cline wants to use ${prompts.length} subagents`,
        config.autoApprovalSettings.enableNotifications,
      );
      const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
        "use_subagents",
        approvalBody,
        config,
      );
      if (!didApprove) {
        telemetryService.captureToolUsage(
          config.ulid,
          this.name,
          config.api.getModel().id,
          provider,
          false,
          false,
          undefined,
          block.isNativeToolCall,
        );
        return formatResponse.toolDenied();
      }
      telemetryService.captureToolUsage(
        config.ulid,
        this.name,
        config.api.getModel().id,
        provider,
        false,
        true,
        undefined,
        block.isNativeToolCall,
      );
    }

    config.taskState.consecutiveMistakeCount = 0;

    const entries: SubagentStatusItem[] = prompts.map((prompt, index) => ({
      index: index + 1,
      prompt,
      status: "pending",
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      contextTokens: 0,
      contextWindow: 0,
      contextUsagePercentage: 0,
      latestToolCall: undefined,
    }));

    const emitStatus = async (
      status: ClineSaySubagentStatus["status"],
      partial: boolean,
    ) => {
      const completed = entries.filter(
        (entry) => entry.status === "completed" || entry.status === "failed",
      ).length;
      const successes = entries.filter(
        (entry) => entry.status === "completed",
      ).length;
      const failures = entries.filter(
        (entry) => entry.status === "failed",
      ).length;
      const toolCalls = entries.reduce(
        (acc, entry) => acc + (entry.toolCalls || 0),
        0,
      );
      const inputTokens = entries.reduce(
        (acc, entry) => acc + (entry.inputTokens || 0),
        0,
      );
      const outputTokens = entries.reduce(
        (acc, entry) => acc + (entry.outputTokens || 0),
        0,
      );
      const contextWindow = entries.reduce(
        (acc, entry) => Math.max(acc, entry.contextWindow || 0),
        0,
      );
      const maxContextTokens = entries.reduce(
        (acc, entry) => Math.max(acc, entry.contextTokens || 0),
        0,
      );
      const maxContextUsagePercentage = entries.reduce(
        (acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0),
        0,
      );

      const payload: ClineSaySubagentStatus = {
        status,
        total: entries.length,
        completed,
        successes,
        failures,
        toolCalls,
        inputTokens,
        outputTokens,
        contextWindow,
        maxContextTokens,
        maxContextUsagePercentage,
        items: entries,
      };

      await config.callbacks.say(
        "subagent",
        JSON.stringify(payload),
        undefined,
        undefined,
        partial,
      );
    };

    let statusUpdateQueue: Promise<void> = Promise.resolve();
    const queueStatusUpdate = (
      status: ClineSaySubagentStatus["status"],
      partial: boolean,
    ): Promise<void> => {
      statusUpdateQueue = statusUpdateQueue
        .catch(() => undefined)
        .then(() => emitStatus(status, partial));
      return statusUpdateQueue;
    };

    await config.callbacks.removeLastPartialMessageIfExistsWithType(
      "say",
      "subagent",
    );
    await queueStatusUpdate("running", true);

    const runners = prompts.map(
      () => new SubagentRunner(config, configuredSubagentName),
    );
    const abortPollInterval = setInterval(() => {
      if (!config.taskState.abort) {
        return;
      }
      clearInterval(abortPollInterval);
      void Promise.allSettled(runners.map((runner) => runner.abort()));
    }, 100);

    const execution = prompts.map((prompt, index) =>
      runners[index].run(prompt, async (update) => {
        const current = entries[index];
        if (update.status === "running") {
          current.status = "running";
        }
        if (update.status === "completed") {
          current.status = "completed";
        }
        if (update.status === "failed") {
          current.status = "failed";
        }
        if (update.result !== undefined) {
          current.result = update.result;
        }
        if (update.error !== undefined) {
          current.error = update.error;
        }
        if (update.latestToolCall !== undefined) {
          current.latestToolCall = update.latestToolCall;
        }
        if (update.stats) {
          current.toolCalls = update.stats.toolCalls || 0;
          current.inputTokens = update.stats.inputTokens || 0;
          current.outputTokens = update.stats.outputTokens || 0;
          current.totalCost = update.stats.totalCost || 0;
          current.contextTokens = update.stats.contextTokens || 0;
          current.contextWindow = update.stats.contextWindow || 0;
          current.contextUsagePercentage =
            update.stats.contextUsagePercentage || 0;
        }
        await queueStatusUpdate("running", true);
      }),
    );

    const settled = await Promise.allSettled(execution);
    clearInterval(abortPollInterval);
    let usageTokensIn = 0;
    let usageTokensOut = 0;
    let usageCacheWrites = 0;
    let usageCacheReads = 0;
    let usageCost = 0;
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        entries[index].status = "failed";
        entries[index].error =
          (result.reason as Error)?.message || "Subagent execution failed";
        return;
      }
      entries[index].status = result.value.status;
      entries[index].result = result.value.result;
      entries[index].error = result.value.error;
      entries[index].toolCalls = result.value.stats.toolCalls || 0;
      entries[index].inputTokens = result.value.stats.inputTokens || 0;
      entries[index].outputTokens = result.value.stats.outputTokens || 0;
      entries[index].totalCost = result.value.stats.totalCost || 0;
      entries[index].contextTokens = result.value.stats.contextTokens || 0;
      entries[index].contextWindow = result.value.stats.contextWindow || 0;
      entries[index].contextUsagePercentage =
        result.value.stats.contextUsagePercentage || 0;

      usageTokensIn += result.value.stats.inputTokens || 0;
      usageTokensOut += result.value.stats.outputTokens || 0;
      usageCacheWrites += result.value.stats.cacheWriteTokens || 0;
      usageCacheReads += result.value.stats.cacheReadTokens || 0;
      usageCost += result.value.stats.totalCost || 0;
    });

    const failures = entries.filter(
      (entry) => entry.status === "failed",
    ).length;
    await queueStatusUpdate(failures > 0 ? "failed" : "completed", false);

    const subagentUsagePayload: ClineSubagentUsageInfo = {
      source: "subagents",
      tokensIn: usageTokensIn,
      tokensOut: usageTokensOut,
      cacheWrites: usageCacheWrites,
      cacheReads: usageCacheReads,
      cost: usageCost,
    };
    await config.callbacks.say(
      "subagent_usage",
      JSON.stringify(subagentUsagePayload),
    );

    const successCount = entries.length - failures;
    const totalToolCalls = entries.reduce(
      (acc, entry) => acc + (entry.toolCalls || 0),
      0,
    );
    const maxContextUsagePercentage = entries.reduce(
      (acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0),
      0,
    );
    const maxContextTokens = entries.reduce(
      (acc, entry) => Math.max(acc, entry.contextTokens || 0),
      0,
    );
    const contextWindow = entries.reduce(
      (acc, entry) => Math.max(acc, entry.contextWindow || 0),
      0,
    );

    const summary = [
      "Subagent results:",
      `Total: ${entries.length}`,
      `Succeeded: ${successCount}`,
      `Failed: ${failures}`,
      `Tool calls: ${totalToolCalls}`,
      `Peak context usage: ${maxContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${maxContextUsagePercentage.toFixed(1)}%)`,
      "",
      ...entries.map((entry) => {
        const header = `[${entry.index}] ${entry.status.toUpperCase()} - ${entry.prompt}`;
        const detail =
          entry.status === "completed"
            ? excerpt(entry.result)
            : excerpt(entry.error);
        return detail ? `${header}\n${detail}` : header;
      }),
    ].join("\n");

    return formatResponse.toolResult(summary);
  }
}
```

**Key flow**:

1. User (via Claude prompt) triggers `use_subagents` tool
2. Handler validates prompts and auto-approval settings
3. Initializes `SubagentStatusItem[]` array with all items in "pending" state
4. Spins up parallel `SubagentRunner` instances (one per prompt)
5. Each runner executes and calls the `onProgress` callback with updates

### What Event is Emitted on Each Update

**File**: `/src/core/task/tools/subagent/SubagentRunner.ts` (lines 295-693)

The `run()` method executes the sub-agent and calls `onProgress()` callback at key points:

```typescript
async run(prompt: string, onProgress: (update: SubagentProgressUpdate) => void): Promise<SubagentRunResult> {
	this.abortRequested = false
	const state = new TaskState()
	let emptyAssistantResponseRetries = 0
	const contextState: SubagentContextState = {}
	const contextManager = new ContextManager()
	const usageState: SubagentUsageState = {
		currentRequest: createEmptyRequestUsageState(),
	}
	const stats: SubagentRunStats = {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	}

	onProgress({ status: "running", stats })
	// ... streaming loop
	// After each tool call:
	const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
	onProgress({ latestToolCall })

	// After usage chunk received:
	onProgress({ stats: { ...stats } })

	// On completion:
	onProgress({ status: "completed", result: completionResult, stats: { ...stats } })
	return { status: "completed", result: completionResult, stats }

	// On failure:
	onProgress({ status: "failed", error: errorText, stats: { ...stats } })
	return { status: "failed", error: errorText, stats }
}
```

### Events Emitted to UI

From `SubagentToolHandler.execute()`:

1. **Initial "running" state** (partial):

   ```typescript
   await queueStatusUpdate("running", true);
   ```

   Emits: `{ status: "running", items: [...], toolCalls: 0, ... }`

2. **Per-tool-call update** (partial):
   Each runner's `onProgress({ latestToolCall })` triggers:

   ```typescript
   await queueStatusUpdate("running", true);
   ```

   Updates the entries array with new tool call name and incremented stats.

3. **Per-token usage update** (partial):
   Runner calls `onProgress({ stats })` on each usage chunk, triggers same status emit.

4. **Final completion** (non-partial):

   ```typescript
   const failures = entries.filter((entry) => entry.status === "failed").length;
   await queueStatusUpdate(failures > 0 ? "failed" : "completed", false);
   ```

5. **Separate usage summary**:
   ```typescript
   await config.callbacks.say(
     "subagent_usage",
     JSON.stringify(subagentUsagePayload),
   );
   ```

---

## Part 2: Wire Format

### Type Definitions

**File**: `/src/shared/ExtensionMessage.ts` (lines 270-321)

```typescript
export type SubagentExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface SubagentStatusItem {
  index: number;
  prompt: string;
  status: SubagentExecutionStatus;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  contextTokens: number;
  contextWindow: number;
  contextUsagePercentage: number;
  latestToolCall?: string;
  result?: string;
  error?: string;
}

export interface ClineSaySubagentStatus {
  status: "running" | "completed" | "failed";
  total: number;
  completed: number;
  successes: number;
  failures: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  maxContextTokens: number;
  maxContextUsagePercentage: number;
  items: SubagentStatusItem[];
}

export interface ClineAskUseSubagents {
  prompts: string[];
}

export interface ClineSubagentUsageInfo {
  source: "subagents";
  tokensIn: number;
  tokensOut: number;
  cacheWrites: number;
  cacheReads: number;
  cost: number;
}
```

### Message Structure

Two message types carry sub-agent data:

#### 1. **Approval Request** (user needs to approve sub-agent launch)

```json
{
  "type": "ask",
  "ask": "use_subagents",
  "ts": 1234567890,
  "text": "{\"prompts\": [\"Investigate auth flow\", \"Map out DB schema\"]}"
}
```

#### 2. **Sub-Agent Status Update** (streaming status during execution)

```json
{
  "type": "say",
  "say": "subagent",
  "ts": 1234567890,
  "partial": true,
  "text": "{\"status\": \"running\", \"total\": 2, \"completed\": 1, \"successes\": 0, \"failures\": 0, \"toolCalls\": 3, \"inputTokens\": 1200, \"outputTokens\": 450, \"contextWindow\": 100000, \"maxContextTokens\": 5000, \"maxContextUsagePercentage\": 5.0, \"items\": [{\"index\": 1, \"prompt\": \"Investigate auth flow\", \"status\": \"completed\", \"toolCalls\": 2, \"inputTokens\": 600, \"outputTokens\": 250, \"totalCost\": 0.002, \"contextTokens\": 2500, \"contextWindow\": 100000, \"contextUsagePercentage\": 2.5, \"result\": \"Found JWT validation in middleware.ts\"}]}"
}
```

#### 3. **Sub-Agent Usage Summary** (final token/cost rollup)

```json
{
  "type": "say",
  "say": "subagent_usage",
  "ts": 1234567890,
  "text": "{\"source\": \"subagents\", \"tokensIn\": 2400, \"tokensOut\": 900, \"cacheWrites\": 0, \"cacheReads\": 0, \"cost\": 0.005}"
}
```

### How It Routes to WebView

**File**: `/src/core/webview.ts` (not shown, but pattern consistent with VSCode WebView Panel API)

The extension holds a `WebviewPanel` reference. When `config.callbacks.say()` is called:

```typescript
// Pseudocode:
await config.callbacks.say(
  "subagent",
  JSON.stringify(payload),
  undefined,
  undefined,
  partial,
);
// Internally calls:
webviewPanel.webview.postMessage({
  type: "message",
  messages: [
    {
      ts: Date.now(),
      type: "say",
      say: "subagent",
      text: JSON.stringify(payload),
      partial: true,
    },
  ],
});
```

The webview listens for this via VSCode's `window.addEventListener('message', ...)` and dispatches it to React state.

---

## Part 3: Client-Side State

### Where State Flows Into React

The webview receives the `ExtensionMessage` and dispatches it through a central message handler. Based on Cline's architecture, the messages are stored in a Redux-like state tree or Jotai atoms:

**Implied path** (reconstructed from component structure):

1. `window.addEventListener('message', handleExtensionMessage)`
2. Parse message → extract `say: "subagent"` and text payload
3. Dispatch to state manager (likely Redux or Jotai)
4. React components subscribe to state updates

### State Shape (Inferred from SubagentStatusRow)

The `SubagentStatusRow` component receives a `ClineMessage` prop and parses it inline:

```typescript
interface SubagentRowData {
  status: SubagentRowStatus; // "pending" | "running" | "completed" | "failed"
  items: SubagentStatusItem[];
}

interface SubagentStatusItem {
  index: number;
  prompt: string;
  status: SubagentExecutionStatus;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  contextTokens: number;
  contextWindow: number;
  contextUsagePercentage: number;
  latestToolCall?: string;
  result?: string;
  error?: string;
}

function parseSubagentRowData(message: ClineMessage): SubagentRowData | null {
  if (!message.text) {
    return null;
  }

  try {
    if (message.ask === "use_subagents" || message.say === "use_subagents") {
      const parsed = JSON.parse(message.text) as ClineAskUseSubagents;
      if (!Array.isArray(parsed.prompts)) {
        return null;
      }
      const prompts = parsed.prompts
        .map((prompt) => prompt?.trim())
        .filter((prompt): prompt is string => !!prompt);
      if (prompts.length === 0) {
        return null;
      }

      return {
        status: "pending",
        items: prompts.map((prompt, index) => ({
          index: index + 1,
          prompt,
          status: "pending",
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          contextTokens: 0,
          contextWindow: 0,
          contextUsagePercentage: 0,
        })),
      };
    }

    const parsed = JSON.parse(message.text) as ClineSaySubagentStatus;
    if (!Array.isArray(parsed.items)) {
      return null;
    }

    return {
      status: parsed.status,
      items: parsed.items,
    };
  } catch {
    return null;
  }
}
```

**Key insight**: State is **not centralized**. Each message is parsed on-demand inside the component using `useMemo()`. The message itself is the source of truth.

---

## Part 4: Rendering

### Full SubagentStatusRow Component

**File**: `/webview-ui/src/components/chat/SubagentStatusRow.tsx` (complete, 286 lines)

```typescript
import {
	ClineAskUseSubagents,
	ClineMessage,
	ClineSaySubagentStatus,
	SubagentExecutionStatus,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import {
	BotIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	LoaderCircleIcon,
	NetworkIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import MarkdownBlock from "../common/MarkdownBlock"

interface SubagentStatusRowProps {
	message: ClineMessage
	isLast: boolean
	lastModifiedMessage?: ClineMessage
}

type DisplayStatus = SubagentExecutionStatus | "cancelled"
type SubagentRowStatus = "pending" | "running" | "completed" | "failed"

interface SubagentRowData {
	status: SubagentRowStatus
	items: SubagentStatusItem[]
}

interface SubagentPromptTextProps {
	prompt: string
	isExpanded: boolean
	onShowMore: () => void
}

const statusIcon = (status: DisplayStatus) => {
	switch (status) {
		case "running":
			return <LoaderCircleIcon className="size-2 animate-spin text-link shrink-0 mt-[1px]" />
		case "completed":
			return <CheckIcon className="size-2 text-success shrink-0 mt-[1px]" />
		case "failed":
			return <CircleXIcon className="size-2 text-error shrink-0 mt-[1px]" />
		case "cancelled":
			return <CircleSlashIcon className="size-2 text-foreground shrink-0 mt-[1px]" />
		default:
			return <BotIcon className="size-2 text-foreground/70 shrink-0 mt-[1px]" />
	}
}

const formatCount = (value: number | undefined): string => {
	if (!Number.isFinite(value)) {
		return "0"
	}

	return Intl.NumberFormat("en-US").format(value || 0)
}

const formatCost = (value: number | undefined): string => {
	const normalized = Number.isFinite(value) ? Math.max(0, value || 0) : 0
	const maximumFractionDigits = normalized >= 0.01 ? 2 : 4
	return Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits,
	}).format(normalized)
}

function parseSubagentRowData(message: ClineMessage): SubagentRowData | null {
	if (!message.text) {
		return null
	}

	try {
		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			const parsed = JSON.parse(message.text) as ClineAskUseSubagents
			if (!Array.isArray(parsed.prompts)) {
				return null
			}
			const prompts = parsed.prompts.map((prompt) => prompt?.trim()).filter((prompt): prompt is string => !!prompt)
			if (prompts.length === 0) {
				return null
			}

			return {
				status: "pending",
				items: prompts.map((prompt, index) => ({
					index: index + 1,
					prompt,
					status: "pending",
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					contextTokens: 0,
					contextWindow: 0,
					contextUsagePercentage: 0,
				})),
			}
		}

		const parsed = JSON.parse(message.text) as ClineSaySubagentStatus
		if (!Array.isArray(parsed.items)) {
			return null
		}

		return {
			status: parsed.status,
			items: parsed.items,
		}
	} catch {
		return null
	}
}

function SubagentPromptText({ prompt, isExpanded, onShowMore }: SubagentPromptTextProps) {
	const promptRef = useRef<HTMLDivElement | null>(null)
	const [showMoreVisible, setShowMoreVisible] = useState(false)

	useEffect(() => {
		if (isExpanded) {
			setShowMoreVisible(false)
			return
		}

		const element = promptRef.current
		if (!element) {
			setShowMoreVisible(false)
			return
		}

		const checkOverflow = () => {
			setShowMoreVisible(element.scrollHeight - element.clientHeight > 1)
		}

		checkOverflow()

		if (typeof ResizeObserver === "undefined") {
			return
		}

		const observer = new ResizeObserver(() => checkOverflow())
		observer.observe(element)

		return () => observer.disconnect()
	}, [prompt, isExpanded])

	return (
		<div className="relative">
			<div
				className={`text-xs font-medium text-foreground whitespace-pre-wrap break-words ${!isExpanded ? "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" : ""}`}
				ref={promptRef}>
				"{prompt}"
			</div>
			{!isExpanded && showMoreVisible && (
				<button
					aria-label="Show full subagent prompt"
					className="absolute right-0 bottom-0 z-10 text-[11px] text-link border-0 px-1 py-[1px] cursor-pointer leading-none rounded-[2px]"
					onClick={onShowMore}
					style={{ backgroundColor: "var(--vscode-editor-background)" }}
					type="button">
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 -left-[6px] w-[6px]"
						style={{ background: "linear-gradient(to left, var(--vscode-editor-background), transparent)" }}
					/>
					Show more
				</button>
			)}
		</div>
	)
}

export default function SubagentStatusRow({ message, isLast, lastModifiedMessage }: SubagentStatusRowProps) {
	const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({})
	const [expandedPrompts, setExpandedPrompts] = useState<Record<number, boolean>>({})
	const data = useMemo(() => parseSubagentRowData(message), [message])

	if (!data) {
		return <div className="text-foreground opacity-80">Subagent status update unavailable.</div>
	}

	const resumedBeforeNextVisibleMessage =
		isLast && lastModifiedMessage?.say === "api_req_started" && (lastModifiedMessage.ts ?? 0) > message.ts

	const wasCancelled =
		data.status === "running" &&
		(!isLast ||
			lastModifiedMessage?.ask === "resume_task" ||
			lastModifiedMessage?.ask === "resume_completed_task" ||
			resumedBeforeNextVisibleMessage)

	const singular = data.items.length === 1
	const title = singular ? "Cline wants to use a subagent:" : "Cline wants to use subagents:"
	const isPromptConstructionRow = message.ask === "use_subagents" || message.say === "use_subagents"
	const toggleItem = (index: number) => {
		setExpandedItems((prev) => ({
			...prev,
			[index]: !prev[index],
		}))
	}
	const expandPrompt = (index: number) => {
		setExpandedPrompts((prev) => ({
			...prev,
			[index]: true,
		}))
	}

	return (
		<div className="mb-2">
			<div className="flex items-center gap-2.5 mb-3">
				<NetworkIcon className="size-2 text-foreground" />
				<span className="font-bold text-foreground">{title}</span>
			</div>
			<div className="space-y-2">
				{data.items.map((entry, index) => {
					const displayStatus: DisplayStatus =
						wasCancelled && (entry.status === "running" || entry.status === "pending") ? "cancelled" : entry.status
					const hasDetails = Boolean(
						(entry.result && entry.status === "completed") || (entry.error && entry.status === "failed"),
					)
					const isExpanded = expandedItems[entry.index] === true
					const isStreamingPromptUnderConstruction =
						isPromptConstructionRow && message.partial === true && index === data.items.length - 1
					const shouldShowStats = !isStreamingPromptUnderConstruction
					const statsText = `${formatCount(entry.toolCalls)} tools called · ${formatCount(entry.contextTokens)} tokens · ${formatCost(entry.totalCost)}`
					const latestToolCallText = entry.latestToolCall?.trim() || ""
					return (
						<div
							className="rounded-xs border border-editor-group-border px-2 py-1.5"
							key={entry.index}
							style={{ backgroundColor: "var(--vscode-editor-background)" }}>
							<div className="flex items-start gap-2">
								{statusIcon(displayStatus)}
								<div className="min-w-0 flex-1">
									<SubagentPromptText
										isExpanded={expandedPrompts[entry.index] === true}
										onShowMore={() => expandPrompt(entry.index)}
										prompt={entry.prompt}
									/>
								</div>
							</div>
							{shouldShowStats && (
								<div className="mt-1 text-[11px] opacity-70 min-w-0 whitespace-pre-wrap break-words">
									<span>{statsText}</span>
								</div>
							)}
							{shouldShowStats && hasDetails && (
								<button
									aria-label={isExpanded ? "Hide subagent output" : "Show subagent output"}
									className="mt-1 text-[11px] opacity-80 flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-left text-foreground w-full"
									onClick={() => toggleItem(entry.index)}
									type="button">
									{isExpanded ? (
										<ChevronDownIcon className="size-2 shrink-0" />
									) : (
										<ChevronRightIcon className="size-2 shrink-0" />
									)}
									<span className="shrink-0">{isExpanded ? "Hide output" : "Show output"}</span>
								</button>
							)}
							{shouldShowStats && !hasDetails && latestToolCallText && (
								<div className="mt-1 text-[10px] opacity-70 min-w-0 truncate font-mono">{latestToolCallText}</div>
							)}
							{isExpanded && entry.result && entry.status === "completed" && (
								<div className="mt-2 text-xs opacity-80 wrap-anywhere overflow-hidden">
									<MarkdownBlock markdown={entry.result} />
								</div>
							)}
							{isExpanded && entry.error && entry.status === "failed" && (
								<div className="mt-2 text-xs text-error whitespace-pre-wrap break-words">{entry.error}</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
```

### CSS / Tailwind Classes Breakdown

| Class                                                          | Purpose                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `mb-2`                                                         | Bottom margin on outer container                               |
| `flex items-center gap-2.5`                                    | Horizontal flex with centered vertical alignment; icon + title |
| `mb-3`                                                         | Bottom margin on title section                                 |
| `size-2`                                                       | Icon size (0.5rem × 0.5rem)                                    |
| `text-link`, `text-success`, `text-error`                      | Color variants (from VSCode theme)                             |
| `animate-spin`                                                 | CSS animation for loading spinner                              |
| `shrink-0`                                                     | Prevent icon from shrinking in flex                            |
| `text-foreground`, `text-foreground/70`                        | Text colors (primary and muted)                                |
| `font-bold`                                                    | Title font weight                                              |
| `space-y-2`                                                    | Vertical gap between status items (0.5rem)                     |
| `rounded-xs border border-editor-group-border`                 | Card styling: small border radius + subtle border              |
| `px-2 py-1.5`                                                  | Padding inside card (horizontal 0.5rem, vertical 0.375rem)     |
| `bg-[--vscode-editor-background]`                              | Card background (inline style for dynamic VSCode theme)        |
| `flex items-start gap-2`                                       | Icon + prompt flex; items aligned to start                     |
| `min-w-0 flex-1`                                               | Prevent prompt text from overflowing; take remaining width     |
| `overflow-hidden [display:-webkit-box] [-webkit-line-clamp:2]` | Truncate prompt to 2 lines (webkit CSS)                        |
| `mt-1 text-[11px] opacity-70`                                  | Stats row styling: small font, muted                           |
| `text-[11px] opacity-80 flex items-center gap-1`               | Toggle button: small font, icon + text                         |
| `bg-transparent border-0 p-0`                                  | Button reset styling                                           |
| `cursor-pointer text-left text-foreground w-full`              | Interactive styling + full width                               |
| `mt-2 text-xs opacity-80`                                      | Result/error container: padding + muted text                   |
| `text-error whitespace-pre-wrap break-words`                   | Error text: red color + preserve whitespace                    |

### CLI/TUI Rendering

**File**: `/cli/src/components/SubagentMessage.tsx` (361 lines)

For completeness, the CLI version uses Ink (terminal UI framework):

```typescript
export const SubagentMessage: React.FC<SubagentMessageProps> = ({ message, mode, isStreaming }) => {
	const { type, ask, say, text, partial } = message
	const toolColor = mode === "plan" ? "yellow" : COLORS.primaryBlue
	const { columns } = useTerminalSize()
	const promptWidth = Math.max(MIN_PROMPT_WIDTH, columns - 2 - TREE_PREFIX_WIDTH)

	if ((type === "ask" && ask === "use_subagents") || say === "use_subagents") {
		const parsed = text
			? jsonParseSafe<ClineAskUseSubagents>(text, {
					prompts: [],
				})
			: { prompts: [] }

		const prompts = (parsed.prompts || []).map((prompt) => prompt?.trim()).filter(Boolean)
		if (prompts.length === 0) {
			return (
				<Box flexDirection="column" marginBottom={1} width="100%">
					<DotRow color={toolColor}>
						<Text color={toolColor}>Cline wants to run subagents:</Text>
					</DotRow>
				</Box>
			)
		}

		const singular = prompts.length === 1
		return (
			<Box flexDirection="column" marginBottom={1} width="100%">
				<DotRow color={toolColor} flashing={partial === true && isStreaming}>
					<Text color={toolColor}>{singular ? "Cline wants to run a subagent:" : "Cline wants to run subagents:"}</Text>
				</DotRow>
				<Box flexDirection="column" marginLeft={2} width="100%">
					{prompts.map((prompt, index) => {
						const isLastPrompt = index === prompts.length - 1
						const branch = isLastPrompt ? "└─" : "├─"
						const continuationPrefix = isLastPrompt ? "     " : "│    "
						const shouldShowPromptStats = partial !== true || !isLastPrompt
						return (
							<Box flexDirection="column" key={`${prompt}-${index}`}>
								<TreePromptRow
									color={toolColor}
									continuationPrefix={continuationPrefix}
									prefix={<Text color={toolColor}>{`${branch} `}</Text>}
									prompt={prompt}
									promptWidth={promptWidth}
								/>
								{shouldShowPromptStats && (
									<TreeStatsRow
										prefix={continuationPrefix}
										stats={formatSubagentStatsValues(undefined, undefined, undefined)}
									/>
								)}
							</Box>
						)
					})}
				</Box>
			</Box>
		)
	}

	if (say === "subagent" && text) {
		const parsed = jsonParseSafe<ClineSaySubagentStatus>(text, {
			status: "running",
			total: 0,
			completed: 0,
			successes: 0,
			failures: 0,
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			contextWindow: 0,
			maxContextTokens: 0,
			maxContextUsagePercentage: 0,
			items: [],
		})

		const items = parsed.items || []
		if (items.length === 0) {
			return null
		}

		return (
			<Box flexDirection="column" marginBottom={1} width="100%">
				<DotRow color={toolColor} flashing={partial === true && isStreaming}>
					<Text color={toolColor}>
						{items.length === 1 ? "Cline is running a subagent:" : "Cline is running subagents:"}
					</Text>
				</DotRow>
				<Box flexDirection="column" marginLeft={2} width="100%">
					{items.map((entry, index) => {
						const isLastEntry = index === items.length - 1
						const branch = isLastEntry ? "└─" : "├─"
						const continuationPrefix = isLastEntry ? "     " : "│    "
						const key = `${entry.index}-${index}`
						const shouldShowStats = true

						if (entry.status === "completed") {
							return (
								<Box flexDirection="column" key={key}>
									<TreePromptRow
										color="green"
										continuationPrefix={continuationPrefix}
										prefix={
											<Box flexDirection="row">
												<Text color="gray">{`${branch} `}</Text>
												<Text color="green">✓</Text>
											</Box>
										}
										prompt={entry.prompt}
										promptWidth={promptWidth}
									/>
									<TreeStatsRow
										prefix={continuationPrefix}
										stats={formatSubagentStatsValues(
											entry.toolCalls,
											entry.contextTokens,
											entry.totalCost,
											entry.latestToolCall,
										)}
									/>
								</Box>
							)
						}

						if (entry.status === "failed") {
							return (
								<Box flexDirection="column" key={key}>
									<TreePromptRow
										color="red"
										continuationPrefix={continuationPrefix}
										prefix={
											<Box flexDirection="row">
												<Text color="gray">{`${branch} `}</Text>
												<Text color="red">✗</Text>
											</Box>
										}
										prompt={entry.prompt}
										promptWidth={promptWidth}
									/>
									<TreeStatsRow
										prefix={continuationPrefix}
										stats={formatSubagentStatsValues(
											entry.toolCalls,
											entry.contextTokens,
											entry.totalCost,
											entry.latestToolCall,
										)}
									/>
								</Box>
							)
						}

						return (
							<Box flexDirection="column" key={key}>
								<TreePromptRow
									color={toolColor}
									continuationPrefix={continuationPrefix}
									prefix={
										<Box flexDirection="row">
											<Text color="gray">{branch} </Text>
											{entry.status === "running" ? (
												<Text color={toolColor}>
													<Spinner type="dots" />
												</Text>
											) : (
												<Text color={toolColor}>•</Text>
											)}
										</Box>
									}
									prompt={entry.prompt}
									promptWidth={promptWidth}
								/>
								{shouldShowStats && (
									<TreeStatsRow
										prefix={continuationPrefix}
										stats={formatSubagentStatsValues(
											entry.toolCalls,
											entry.contextTokens,
											entry.totalCost,
											entry.latestToolCall,
										)}
									/>
								)}
							</Box>
						)
					})}
				</Box>
			</Box>
		)
	}

	return null
}
```

### Parent Integration

**File**: `/webview-ui/src/components/chat/ChatRow.tsx` (lines 768-769 and 1083-1084)

Two entry points:

```typescript
// Entry 1: Render "use_subagents" approval request
if (message.ask === "use_subagents" || message.say === "use_subagents") {
	return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
}

// Entry 2: Render "subagent" status stream
case "subagent":
	return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
```

---

## Part 5: Stop/Cancel Behavior

### Cancel Button Presence

**There is no explicit "cancel sub-agent" button on the SubagentStatusRow component.**

Instead, cancellation is implicit:

1. **User stops task** (top-level stop button in chat header)
2. `config.taskState.abort = true` is set
3. SubagentRunner polls this flag in its main loop:
   ```typescript
   if (this.shouldAbort()) {
     await this.abort();
     const error = "Subagent run cancelled.";
     onProgress({ status: "failed", error, stats: { ...stats } });
     return { status: "failed", error, stats };
   }
   ```
4. UI detects the status transitioned to "failed" and displays error

### Detecting Cancellation in UI

The component tracks if a sub-agent was cancelled post-hoc:

```typescript
const resumedBeforeNextVisibleMessage =
  isLast &&
  lastModifiedMessage?.say === "api_req_started" &&
  (lastModifiedMessage.ts ?? 0) > message.ts;

const wasCancelled =
  data.status === "running" &&
  (!isLast ||
    lastModifiedMessage?.ask === "resume_task" ||
    lastModifiedMessage?.ask === "resume_completed_task" ||
    resumedBeforeNextVisibleMessage);
```

If the sub-agent message shows "running" status but is no longer the last message in the thread (a new message came after), the UI retroactively marks running items as "cancelled":

```typescript
const displayStatus: DisplayStatus =
  wasCancelled && (entry.status === "running" || entry.status === "pending")
    ? "cancelled"
    : entry.status;
```

The cancelled status renders a `CircleSlashIcon` (⊘ icon) in the UI.

---

## Part 6: Adaptation for Terragon

### Concrete Mapping: Cline Events → AG-UI Protocol

Our AG-UI protocol has: `RUN_STARTED`, `TEXT_MESSAGE_DELTA`, `TOOL_CALL_STARTED`, `TOOL_CALL_DELTA`, `TOOL_CALL_COMPLETED`, `CUSTOM`, etc.

**Proposed adaptation**:

| Cline Event                 | AG-UI Mapping                                                                                               | Payload |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| Initial "running" broadcast | `CUSTOM` → `{ type: "subagent", event: "status_update", status: "running", items: [...] }`                  | JSON    |
| Per-tool-call update        | `CUSTOM` → `{ type: "subagent", event: "status_update", items: [{ latestToolCall: "...", stats: {...} }] }` | JSON    |
| Final "completed"/"failed"  | `CUSTOM` → `{ type: "subagent", event: "status_update", status: "completed/failed", items: [...] }`         | JSON    |
| Sub-agent usage summary     | `CUSTOM` → `{ type: "subagent_usage", tokensIn: 2400, tokensOut: 900, ... }`                                | JSON    |

The reason to use `CUSTOM` events: AG-UI's event types are designed for Claude's top-level agent execution flow. Sub-agents are a **delegated execution context** separate from the main agent, so custom events preserve that semantic distinction and avoid polluting the core protocol.

### Suggested File Structure in Terragon

```
apps/www/src/
├── components/
│   └── chat/
│       ├── subagent/
│       │   ├── SubagentStatusRow.tsx        # Main status card component
│       │   ├── SubagentStatusRow.module.css # Tailwind equivalents
│       │   ├── SubagentPromptText.tsx       # Expandable prompt text
│       │   └── SubagentStatsDisplay.tsx     # Token/cost/tools display
│       │
│       └── ChatMessage.tsx                   # Parent that mounts SubagentStatusRow
│
├── server/
│   └── lib/
│       ├── subagent-runner.ts               # Parallelize sub-agent execution
│       ├── subagent-types.ts                # TypeScript interfaces (SubagentStatusItem, etc.)
│       └── subagent-emitter.ts              # Emit subagent events via AG-UI protocol
│
└── db/
    └── schema/
        └── subagent-runs.ts                 # Optional: track historical sub-agent runs
```

### Type Definitions to Create

```typescript
// subagent-types.ts

export type SubagentStatus = "pending" | "running" | "completed" | "failed";

export interface SubagentStats {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  contextTokens: number;
  contextWindow: number;
  contextUsagePercentage: number;
}

export interface SubagentStatusItem {
  index: number;
  prompt: string;
  status: SubagentStatus;
  stats: SubagentStats;
  latestToolCall?: string;
  result?: string;
  error?: string;
}

export interface SubagentStatusEvent {
  type: "subagent";
  event: "status_update";
  status: SubagentStatus;
  items: SubagentStatusItem[];
  total: number;
  completed: number;
  successes: number;
  failures: number;
}

export interface SubagentUsageEvent {
  type: "subagent_usage";
  tokensIn: number;
  tokensOut: number;
  cacheWrites: number;
  cacheReads: number;
  cost: number;
}
```

### Three Biggest Risks / Gotchas

#### 1. **State Mutation & React Reconciliation**

- **Risk**: Updating `SubagentStatusItem[]` in-place (e.g., `entries[0].status = "running"`) will NOT trigger React re-render.
- **Mitigation**: Ensure every `onProgress()` callback in the runner creates a **new array reference**. Use immutable patterns:
  ```typescript
  setSubagents((prev) =>
    prev.map((item, idx) =>
      idx === index ? { ...item, status: "running" } : item,
    ),
  );
  ```
- **Cline avoids this** by parsing the JSON payload fresh on every message; no mutable state.

#### 2. **Streaming Partial Messages & Out-of-Order Delivery**

- **Risk**: If network hiccups cause messages to arrive out of order (e.g., "completed" before all "running" updates), the UI may briefly show a completed sub-agent, then jump back to "running".
- **Mitigation**:
  - Use message timestamps (`message.ts`) to discard out-of-order updates.
  - Compare incoming status with current state and only apply if it's a forward transition (running → completed is OK; completed → running is ignored).
- **Cline's approach**: Parses on-demand from message.text, so ordering is implicit in the message sequence.

#### 3. **Tokens vs. Context Semantics**

- **Risk**: `contextTokens` in Cline's UI ("2500 tokens") is actually total tokens used so far (input + output + cache), not context window size.
- **Gotcha**: If you label it "Context: 2500", users will think the sub-agent used 2500 of its max context window, which is wrong. The value is **cumulative**.
- **Mitigation**: Label clearly: "2500 tokens used · 5% of window" (as Cline does: `formatCount(entry.contextTokens) tokens · formatCost(entry.totalCost)`).
- **Test with users** if you're unsure of the label.

---

## Appendix: Component Mounting Path

**Full stack trace** of how SubagentStatusRow gets rendered:

1. Extension sends message: `say: "subagent", text: JSON.stringify(ClineSaySubagentStatus)`
2. Webview receives `postMessage()` event
3. Message dispatch → React state (cline-messages atom or Redux slice)
4. ChatView component renders message list
5. For each message, ChatRow component decides what to render
6. ChatRow checks: `if (message.say === "subagent")` → `return <SubagentStatusRow ... />`
7. SubagentStatusRow parses `message.text`, renders items map
8. Each item renders: icon + prompt + stats + optional expand/collapse
9. On expand, renders result/error markdown via MarkdownBlock
