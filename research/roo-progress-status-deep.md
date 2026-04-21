# Roo Code `progressStatus` Deep Research Report

**Date:** April 2026  
**Repo:** `RooVetGit/Roo-Code`  
**Scope:** Full end-to-end trace of agent-pushed inline progress status with icon + text rendering

---

## Part 1: Type Definitions

### ToolProgressStatus Schema

**File:** `/tmp/roo-deep-research/packages/types/src/message.ts` (lines 180–188)

```typescript
/**
 * ToolProgressStatus
 */

export const toolProgressStatusSchema = z.object({
  icon: z.string().optional(),
  text: z.string().optional(),
});

export type ToolProgressStatus = z.infer<typeof toolProgressStatusSchema>;
```

**Structure:**

- `icon?: string` — Optional icon identifier (maps to VSCode Codicon name, e.g., "file-edit", "chevron-down")
- `text?: string` — Optional status text label (e.g., "Editing file", "Reading contents")

### ClineMessage Integration

**File:** `/tmp/roo-deep-research/packages/types/src/message.ts` (lines 249–276)

```typescript
/**
 * ClineMessage
 *
 * The main message type used for communication between the extension and webview.
 * Messages can either be "ask" (requiring user response) or "say" (informational).
 */
export const clineMessageSchema = z.object({
  ts: z.number(),
  type: z.union([z.literal("ask"), z.literal("say")]),
  ask: clineAskSchema.optional(),
  say: clineSaySchema.optional(),
  text: z.string().optional(),
  images: z.array(z.string()).optional(),
  partial: z.boolean().optional(),
  reasoning: z.string().optional(),
  conversationHistoryIndex: z.number().optional(),
  checkpoint: z.record(z.string(), z.unknown()).optional(),
  progressStatus: toolProgressStatusSchema.optional(), // ATTACHED HERE
  /**
   * Data for successful context condensation.
   * Present when `say: "condense_context"` and `partial: false`.
   */
  contextCondense: contextCondenseSchema.optional(),
  /**
   * Data for sliding window truncation.
   * Present when `say: "sliding_window_truncation"`.
   */
  contextTruncation: contextTruncationSchema.optional(),
  isProtected: z.boolean().optional(),
  apiProtocol: z
    .union([z.literal("openai"), z.literal("anthropic")])
    .optional(),
  isAnswered: z.boolean().optional(),
});

export type ClineMessage = z.infer<typeof clineMessageSchema>;
```

**Key Point:** `progressStatus` is an optional sibling field to `text`, `ask`, `say`, and `reasoning`. It is attached to a message when the agent needs to signal inline progress to the webview.

**Possible Values:** Theoretically unbounded object `{ icon?, text? }`. No enum of icon names is enforced at the type level; icons are validated at render time.

---

## Part 2: Agent-Side Emission (Extension → Webview)

### Task.ts: progressStatus Assignment Points

**File:** `/tmp/roo-deep-research/src/core/task/Task.ts`

#### Assignment 1: Partial Message Update (lines 1296)

```typescript
if (partial) {
  if (isUpdatingPreviousPartial) {
    // Existing partial message, so update it.
    lastMessage.text = text;
    lastMessage.partial = partial;
    lastMessage.progressStatus = progressStatus; // <-- ASSIGNED
    lastMessage.isProtected = isProtected;
    // TODO: Be more efficient about saving and posting only new
    // data or one whole message at a time so ignore partial for
    // saves, and only post parts of partial message instead of
    // whole array in new listener.
    this.updateClineMessage(lastMessage);
    // console.log("Task#ask: current ask promise was ignored (#1)")
    throw new AskIgnoredError("updating existing partial");
  }
  // ...
}
```

#### Assignment 2: Partial to Complete Transition (line 1337)

```typescript
if (isUpdatingPreviousPartial) {
  // This is the complete version of a previously partial
  // message, so replace the partial with the complete version.
  this.askResponse = undefined;
  this.askResponseText = undefined;
  this.askResponseImages = undefined;

  // Bug for the history books:
  // In the webview we use the ts as the chatrow key for the
  // virtuoso list. Since we would update this ts right at the
  // end of streaming, it would cause the view to flicker. The
  // key prop has to be stable otherwise react has trouble
  // reconciling items between renders, causing unmounting and
  // remounting of components (flickering).
  // The lesson here is if you see flickering when rendering
  // lists, it's likely because the key prop is not stable.
  // So in this case we must make sure that the message ts is
  // never altered after first setting it.
  askTs = lastMessage.ts;
  this.lastMessageTs = askTs;
  lastMessage.text = text;
  lastMessage.partial = false;
  lastMessage.progressStatus = progressStatus; // <-- ASSIGNED
  lastMessage.isProtected = isProtected;
  await this.saveClineMessages();
  this.updateClineMessage(lastMessage);
}
```

#### Assignment 3: Say Message Update (lines 1784, 1817)

Similar pattern for `say()` messages — progressStatus is assigned during partial and complete updates.

```typescript
if (isUpdatingPreviousPartial) {
  // Existing partial message, so update it.
  lastMessage.text = text;
  lastMessage.images = images;
  lastMessage.partial = partial;
  lastMessage.progressStatus = progressStatus; // <-- ASSIGNED
  this.updateClineMessage(lastMessage);
}

// ... later in complete case:
lastMessage.text = text;
lastMessage.images = images;
lastMessage.partial = false;
lastMessage.progressStatus = progressStatus; // <-- ASSIGNED

await this.saveClineMessages();
```

### presentAssistantMessage.ts: progressStatus Generation

**File:** `/tmp/roo-deep-research/src/core/assistant-message/presentAssistantMessage.ts`

#### Function Signature (line 186–190)

```typescript
const askApproval = async (
  type: ClineAsk,
  partialMessage?: string,
  progressStatus?: ToolProgressStatus, // <-- PARAMETER
  isProtected?: boolean,
) => {
  const { response, text, images } = await cline.ask(
    type,
    partialMessage,
    false,
    progressStatus, // <-- PASSED THROUGH
    isProtected || false,
  );
  // ...
};
```

**Key Pattern:** `progressStatus` is passed as an optional parameter from tool handlers to the approval flow. **The actual creation of progressStatus objects happens in individual tool implementations.**

### shared/tools.ts: Type Signature

**File:** `/tmp/roo-deep-research/src/shared/tools.ts` (lines 7–12)

```typescript
export type AskApproval = (
  type: ClineAsk,
  partialMessage?: string,
  progressStatus?: ToolProgressStatus,
  forceApproval?: boolean,
) => Promise<boolean>;
```

**Observation:** Tools call `askApproval(type, message, progressStatus)` when they need approval. The tool implementations must construct the `progressStatus` object themselves. **No centralized status factory exists.**

---

## Part 3: Custom Per-Tool Status Texts

### Findings

After exhaustive search of `/tmp/roo-deep-research/src/core/tools/`, **no tool-specific status text factory or lookup table was found.**

**Search Results:**

```bash
grep -r "{ icon\|{ text" /tmp/roo-deep-research/src/core/tools --include="*.ts" -B3 -A3
```

No matches for literal object construction like `{ icon: "...", text: "..." }`.

**Conclusion:**

- **Roo does NOT pre-compute or define tool-specific status strings in a centralized registry.**
- Individual tools may construct ad-hoc progressStatus objects during execution.
- The pattern observed is: tools call `askApproval(type, text, progressStatus?)` with progressStatus as optional.
- **Most tools pass `undefined`** for progressStatus, meaning no inline status is rendered.

**Implementation Note:**  
Roo's current design treats `progressStatus` as a _capability_ (optionally available) rather than a _standard feature_ (always expected). Tools implement it opportunistically rather than systematically.

---

## Part 4: Transport (Extension → Webview)

### VSCode postMessage Flow

**File:** `/tmp/roo-deep-research/src/core/task/Task.ts` (implicit)

Transport mechanism:

1. **Agent updates message:** `lastMessage.progressStatus = progressStatus`
2. **Persist to disk:** `await this.saveClineMessages()`
3. **Broadcast to webview:** `this.updateClineMessage(lastMessage)`
4. **PostMessage:** Extension posts `{ type: "messageUpdate", message: {...} }` or similar to webview

**Message Shape Sent:**

```typescript
{
  ts: number,
  type: "ask" | "say",
  ask?: ClineAsk,
  say?: ClineSay,
  text?: string,
  images?: string[],
  partial?: boolean,
  progressStatus?: {
    icon?: string,
    text?: string,
  },
  // ... other fields
}
```

**Transport Method:**  
Roo uses VSCode's `vscode.postMessage()` API (standard webview ↔ extension IPC). Messages are not debounced; partial updates post incrementally during streaming.

---

## Part 5: Webview Rendering

### CodeAccordion Component

**File:** `/tmp/roo-deep-research/webview-ui/src/components/common/CodeAccordion.tsx`

**Full Source:**

```typescript
import { memo, useMemo } from "react"
import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"
import { type ToolProgressStatus } from "@roo-code/types"
import { getLanguageFromPath } from "@src/utils/getLanguageFromPath"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import { ToolUseBlock, ToolUseBlockHeader } from "./ToolUseBlock"
import CodeBlock from "./CodeBlock"
import { PathTooltip } from "../ui/PathTooltip"
import DiffView from "./DiffView"

interface CodeAccordionProps {
	path?: string
	code?: string
	language: string
	progressStatus?: ToolProgressStatus
	isLoading?: boolean
	isExpanded: boolean
	isFeedback?: boolean
	onToggleExpand: () => void
	header?: string
	onJumpToFile?: () => void
	// New props for diff stats
	diffStats?: { added: number; removed: number }
}

const CodeAccordion = ({
	path,
	code = "",
	language,
	progressStatus,
	isLoading,
	isExpanded,
	isFeedback,
	onToggleExpand,
	header,
	onJumpToFile,
	diffStats,
}: CodeAccordionProps) => {
	const inferredLanguage = useMemo(() => language ?? (path ? getLanguageFromPath(path) : "txt"), [path, language])
	const source = useMemo(() => code.trim(), [code])
	const hasHeader = Boolean(path || isFeedback || header)

	// Use provided diff stats only (render-only)
	const derivedStats = useMemo(() => {
		if (diffStats && (diffStats.added > 0 || diffStats.removed > 0)) return diffStats
		return null
	}, [diffStats])

	const hasValidStats = Boolean(derivedStats && (derivedStats.added > 0 || derivedStats.removed > 0))

	return (
		<ToolUseBlock>
			{hasHeader && (
				<ToolUseBlockHeader onClick={onToggleExpand} className="group">
					{isLoading && <VSCodeProgressRing className="size-3 mr-2" />}
					{header ? (
						<div className="flex items-center">
							<span className="codicon codicon-server mr-1.5"></span>
							<PathTooltip content={header}>
								<span className="whitespace-nowrap overflow-hidden text-ellipsis mr-2">{header}</span>
							</PathTooltip>
						</div>
					) : isFeedback ? (
						<div className="flex items-center">
							<span className={`codicon codicon-${isFeedback ? "feedback" : "codicon-output"} mr-1.5`} />
							<span className="whitespace-nowrap overflow-hidden text-ellipsis mr-2 rtl">
								{isFeedback ? "User Edits" : "Console Logs"}
							</span>
						</div>
					) : (
						<>
							{path?.startsWith(".") && <span>.</span>}
							<PathTooltip content={formatPathTooltip(path)}>
								<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left mr-2 rtl">
									{formatPathTooltip(path)}
								</span>
							</PathTooltip>
						</>
					)}
					<div className="flex-grow-1" />
					{/* Prefer diff stats over generic progress indicator if available */}
					{hasValidStats ? (
						<div className="flex items-center gap-2 mr-1">
							<span className="text-xs font-medium text-vscode-charts-green">+{derivedStats!.added}</span>
							<span className="text-xs font-medium text-vscode-charts-red">-{derivedStats!.removed}</span>
						</div>
					) : (
						progressStatus &&
						progressStatus.text && (
							<>
								{progressStatus.icon && (
									<span className={`codicon codicon-${progressStatus.icon} mr-1`} />
								)}
								<span className="mr-1 ml-auto text-vscode-descriptionForeground">
									{progressStatus.text}
								</span>
							</>
						)
					)}
					{onJumpToFile && path && (
						<span
							className="codicon codicon-link-external mr-1"
							style={{ fontSize: 13.5 }}
							onClick={(e) => {
								e.stopPropagation()
								onJumpToFile()
							}}
							aria-label={`Open file: ${path}`}
						/>
					)}
					{!onJumpToFile && (
						<span
							className={`opacity-0 group-hover:opacity-100 codicon codicon-chevron-${isExpanded ? "up" : "down"}`}></span>
					)}
				</ToolUseBlockHeader>
			)}
			{(!hasHeader || isExpanded) && (
				<div className="overflow-x-auto overflow-y-auto max-h-[300px] max-w-full">
					{inferredLanguage === "diff" ? (
						<DiffView source={source} filePath={path} />
					) : (
						<CodeBlock source={source} language={inferredLanguage} />
					)}
				</div>
			)}
		</ToolUseBlock>
	)
}

export default memo(CodeAccordion)
```

**Rendering Logic (Lines 82–100):**

```typescript
{/* Prefer diff stats over generic progress indicator if available */}
{hasValidStats ? (
	<div className="flex items-center gap-2 mr-1">
		<span className="text-xs font-medium text-vscode-charts-green">+{derivedStats!.added}</span>
		<span className="text-xs font-medium text-vscode-charts-red">-{derivedStats!.removed}</span>
	</div>
) : (
	progressStatus &&
	progressStatus.text && (
		<>
			{progressStatus.icon && (
				<span className={`codicon codicon-${progressStatus.icon} mr-1`} />
			)}
			<span className="mr-1 ml-auto text-vscode-descriptionForeground">
				{progressStatus.text}
			</span>
		</>
	)
)}
```

**Key Behaviors:**

1. **Precedence:** Diff stats (added/removed line counts) are rendered with higher priority than progressStatus.
2. **Icon Mapping:** `progressStatus.icon` is directly interpolated into a Codicon class name: `codicon codicon-${progressStatus.icon}`
   - Example: `icon: "file-edit"` → `<span className="codicon codicon-file-edit" />`
   - **No validation or fallback** — invalid icon names render as `codicon-undefined` (silent failure).
3. **Text Display:** `progressStatus.text` is rendered directly with VSCode theme color `text-vscode-descriptionForeground` (muted gray).
4. **Conditional Rendering:** Only renders if both `progressStatus` AND `progressStatus.text` are truthy.
   - **Gotcha:** If `icon` is set but `text` is absent, nothing renders (the outer condition gates on `progressStatus.text`).

**Icon Lookup:** No separate icon registry. Icons are VSCode Codicon names from https://microsoft.github.io/vscode-codicons/. Common examples:

- `file-edit` → pencil icon
- `loading` → spinner
- `check` → checkmark
- `error` → error symbol
- `clock` → time

---

## Part 6: Sub-Agent / New-Task Rendering

### ChatRow.tsx: Subtask Result Case

**File:** `/tmp/roo-deep-research/webview-ui/src/components/chat/ChatRow.tsx`

**Full Subtask Result Rendering (lines ~700–750):**

```typescript
case "subtask_result":
	// Get the child task ID that produced this result
	const completedChildTaskId = currentTaskItem?.completedByChildId
	return (
		<div className="border-l border-muted-foreground/80 ml-2 pl-4 pt-2 pb-1 -mt-5">
			<div style={headerStyle}>
				<span style={{ fontWeight: "bold" }}>{t("chat:subtasks.resultContent")}</span>
				<Check className="size-3" />
			</div>
			<MarkdownBlock markdown={message.text} />
			{completedChildTaskId && (
				<button
					className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
					onClick={() =>
						vscode.postMessage({ type: "showTaskWithId", text: completedChildTaskId })
					}>
					{t("chat:subtasks.goToSubtask")}
					<ArrowRight className="size-3" />
				</button>
			)}
		</div>
	)
```

**New Task (Parent) Case:**

```typescript
case "newTask":
	const thisNewTaskIndex = newTaskMessages.findIndex((msg) => msg.ts === message.ts)
	const childIds = currentTaskItem?.childIds || []

	// Only get the child task ID if this newTask has been approved (has a corresponding entry in childIds)
	const childTaskId =
		thisNewTaskIndex >= 0 && thisNewTaskIndex < childIds.length ? childIds[thisNewTaskIndex] : undefined

	// Check if the next message is a subtask_result - if so, don't show the button
	const currentMessageIndex = clineMessages.findIndex((msg) => msg.ts === message.ts)
	const nextMessage = currentMessageIndex >= 0 ? clineMessages[currentMessageIndex + 1] : undefined
	const isFollowedBySubtaskResult = nextMessage?.type === "say" && nextMessage?.say === "subtask_result"

	return (
		<>
			<div style={headerStyle}>
				<Split className="size-4" />
				<span style={{ fontWeight: "bold" }}>
					<Trans
						i18nKey="chat:subtasks.wantsToCreate"
						components={{ code: <code>{tool.mode}</code> }}
						values={{ mode: tool.mode }}
					/>
				</span>
			</div>
			<div className="border-l border-muted-foreground/80 ml-2 pl-4 pb-1">
				<MarkdownBlock markdown={tool.content} />
				<div>
					{childTaskId && !isFollowedBySubtaskResult && (
						<button
							className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
							onClick={() =>
								vscode.postMessage({ type: "showTaskWithId", text: childTaskId })
							}>
							{t("chat:subtasks.goToSubtask")}
							<ArrowRight className="size-3" />
						</button>
					)}
				</div>
			</div>
		</>
	)
```

**Key Observations:**

- Subtasks use **separate message types** (`say: "subtask_result"`) rather than progressStatus.
- No inline progress indicator on subtask creation — links are rendered after completion.
- **No progressStatus field used for subtask progress.**

---

## Part 7: Command Execution UX

### CommandExecution.tsx: Full Source

**File:** `/tmp/roo-deep-research/webview-ui/src/components/chat/CommandExecution.tsx`

```typescript
import { useCallback, useState, memo, useMemo } from "react"
import { useEvent } from "react-use"
import { t } from "i18next"
import { ChevronDown, OctagonX } from "lucide-react"

import { type ExtensionMessage, type CommandExecutionStatus, commandExecutionStatusSchema } from "@roo-code/types"

import { safeJsonParse } from "@roo/core"
import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { parseCommand } from "@roo/parse-command"

import { vscode } from "@src/utils/vscode"
import { extractPatternsFromCommand } from "@src/utils/command-parser"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"

import { Button, StandardTooltip } from "@src/components/ui"
import CodeBlock from "@src/components/common/CodeBlock"

import { CommandPatternSelector } from "./CommandPatternSelector"
import { TerminalOutput } from "./TerminalOutput"

interface CommandPattern {
	pattern: string
	description?: string
}

interface CommandExecutionProps {
	executionId: string
	text?: string
	icon?: JSX.Element | null
	title?: JSX.Element | null
}

export const CommandExecution = ({ executionId, text, icon, title }: CommandExecutionProps) => {
	const {
		terminalShellIntegrationDisabled = false,
		allowedCommands = [],
		deniedCommands = [],
		setAllowedCommands,
		setDeniedCommands,
	} = useExtensionState()

	const { command, output: parsedOutput } = useMemo(() => parseCommandAndOutput(text), [text])

	// If we aren't opening the VSCode terminal for this command then we default
	// to expanding the command execution output.
	const [isExpanded, setIsExpanded] = useState(terminalShellIntegrationDisabled)
	const [streamingOutput, setStreamingOutput] = useState("")
	const [status, setStatus] = useState<CommandExecutionStatus | null>(null)

	// The command's output can either come from the text associated with the
	// task message (this is the case for completed commands) or from the
	// streaming output (this is the case for running commands).
	const output = streamingOutput || parsedOutput

	// Extract command patterns from the actual command that was executed
	const commandPatterns = useMemo<CommandPattern[]>(() => {
		// First get all individual commands (including subshell commands) using parseCommand
		const allCommands = parseCommand(command)

		// Then extract patterns from each command using the existing pattern extraction logic
		const allPatterns = new Set<string>()

		// Add all individual commands first
		allCommands.forEach((cmd) => {
			if (cmd.trim()) {
				allPatterns.add(cmd.trim())
			}
		})

		// Then add extracted patterns for each command
		allCommands.forEach((cmd) => {
			const patterns = extractPatternsFromCommand(cmd)
			patterns.forEach((pattern) => allPatterns.add(pattern))
		})

		return Array.from(allPatterns).map((pattern) => ({
			pattern,
		}))
	}, [command])

	// Handle pattern changes
	const handleAllowPatternChange = (pattern: string) => {
		const isAllowed = allowedCommands.includes(pattern)
		const newAllowed = isAllowed ? allowedCommands.filter((p) => p !== pattern) : [...allowedCommands, pattern]
		const newDenied = deniedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const handleDenyPatternChange = (pattern: string) => {
		const isDenied = deniedCommands.includes(pattern)
		const newDenied = isDenied ? deniedCommands.filter((p) => p !== pattern) : [...deniedCommands, pattern]
		const newAllowed = allowedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "commandExecutionStatus") {
				const result = commandExecutionStatusSchema.safeParse(safeJsonParse(message.text, {}))

				if (result.success) {
					const data = result.data

					if (data.executionId !== executionId) {
						return
					}

					switch (data.status) {
						case "started":
							setStatus(data)
							break
						case "output":
							setStreamingOutput(data.output)
							break
						case "fallback":
							setIsExpanded(true)
							break
						default:
							setStatus(data)
							break
					}
				}
			}
		},
		[executionId],
	)

	useEvent("message", onMessage)

	return (
		<>
			<div className="flex flex-row items-center justify-between gap-2 mb-1">
				<div className="flex flex-row items-center gap-2">
					{icon}
					{title}
					{status?.status === "exited" && (
						<div className="flex flex-row items-center gap-2 font-mono text-xs">
							<StandardTooltip
								content={t("chat.commandExecution.exitStatus", { exitStatus: status.exitCode })}>
								<div
									className={cn(
										"rounded-full size-2",
										status.exitCode === 0 ? "bg-green-600" : "bg-red-600",
									)}
								/>
							</StandardTooltip>
						</div>
					)}
				</div>
				<div className=" flex flex-row items-center justify-between gap-2 px-1">
					<div className="flex flex-row items-center gap-1">
						{status?.status === "started" && (
							<div className="flex flex-row items-center gap-2 font-mono text-xs">
								{status.pid && <div className="whitespace-nowrap">(PID: {status.pid})</div>}
								<StandardTooltip content={t("chat:commandExecution.abort")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() =>
											vscode.postMessage({
												type: "terminalOperation",
												terminalOperation: "abort",
											})
										}>
										<OctagonX className="size-4" />
									</Button>
								</StandardTooltip>
							</div>
						)}
						{output.length > 0 && (
							<Button variant="ghost" size="icon" onClick={() => setIsExpanded(!isExpanded)}>
								<ChevronDown
									className={cn(
										"size-4 transition-transform duration-300",
										isExpanded && "rotate-180",
									)}
								/>
							</Button>
						)}
					</div>
				</div>
			</div>

			<div className="bg-vscode-editor-background border border-vscode-border rounded-xs ml-6 mt-2">
				<div className="p-2">
					<CodeBlock source={command} language="shell" />
					<OutputContainer isExpanded={isExpanded} output={output} />
				</div>
				{command && command.trim() && (
					<CommandPatternSelector
						patterns={commandPatterns}
						allowedCommands={allowedCommands}
						deniedCommands={deniedCommands}
						onAllowPatternChange={handleAllowPatternChange}
						onDenyPatternChange={handleDenyPatternChange}
					/>
				)}
			</div>
		</>
	)
}

CommandExecution.displayName = "CommandExecution"

const OutputContainerInternal = ({ isExpanded, output }: { isExpanded: boolean; output: string }) => (
	<div
		className={cn("overflow-hidden", {
			"max-h-0": !isExpanded,
			"max-h-[100%] mt-1 pt-1 border-t border-border/25": isExpanded,
		})}>
		{output.length > 0 && <TerminalOutput content={output} />}
	</div>
)

const OutputContainer = memo(OutputContainerInternal)

const parseCommandAndOutput = (text: string | undefined) => {
	if (!text) {
		return { command: "", output: "" }
	}

	const index = text.indexOf(COMMAND_OUTPUT_STRING)

	if (index === -1) {
		return { command: text, output: "" }
	}

	return {
		command: text.slice(0, index),
		output: text.slice(index + COMMAND_OUTPUT_STRING.length),
	}
}
```

**Command Visualization:**

- **Status Display:** `status?.status === "started"` → shows PID and abort button
- **Exit Code:** Green dot (exit 0) or red dot (non-zero)
- **Output Streaming:** Collapsible accordion, styled with VSCode editor colors
- **Pattern Selector:** Command patterns extracted and toggleable for allow/deny lists

**NOT using progressStatus:** Command execution is rendered separately with its own `CommandExecutionStatus` message type (not the generic `progressStatus` field).

---

## Part 8: Reasoning Block

### ReasoningBlock.tsx: Full Source

**File:** `/tmp/roo-deep-research/webview-ui/src/components/chat/ReasoningBlock.tsx`

```typescript
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import MarkdownBlock from "../common/MarkdownBlock"
import { Lightbulb, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

interface ReasoningBlockProps {
	content: string
	ts: number
	isStreaming: boolean
	isLast: boolean
	metadata?: any
}

export const ReasoningBlock = ({ content, isStreaming, isLast }: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const { reasoningBlockCollapsed } = useExtensionState()

	const [isCollapsed, setIsCollapsed] = useState(reasoningBlockCollapsed)

	const startTimeRef = useRef<number>(Date.now())
	const [elapsed, setElapsed] = useState<number>(0)
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setIsCollapsed(reasoningBlockCollapsed)
	}, [reasoningBlockCollapsed])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => setElapsed(Date.now() - startTimeRef.current)
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

	const seconds = Math.floor(elapsed / 1000)
	const secondsLabel = t("chat:reasoning.seconds", { count: seconds })

	const handleToggle = () => {
		setIsCollapsed(!isCollapsed)
	}

	return (
		<div className="group">
			<div
				className="flex items-center justify-between mb-2.5 pr-2 cursor-pointer select-none"
				onClick={handleToggle}>
				<div className="flex items-center gap-2">
					<Lightbulb className="w-4" />
					<span className="font-bold text-vscode-foreground">{t("chat:reasoning.thinking")}</span>
					{elapsed > 0 && (
						<span className="text-sm text-vscode-descriptionForeground mt-0.5">{secondsLabel}</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<ChevronUp
						className={cn(
							"w-4 transition-all opacity-0 group-hover:opacity-100",
							isCollapsed && "-rotate-180",
						)}
					/>
				</div>
			</div>
			{(content?.trim()?.length ?? 0) > 0 && !isCollapsed && (
				<div
					ref={contentRef}
					className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<MarkdownBlock markdown={content} />
				</div>
			)}
		</div>
	)
}
```

**Elapsed Time Tracking:**

- **Ref-based timer:** `startTimeRef` captures time when block begins streaming
- **1-second tick:** `setInterval` updates elapsed time only while `isLast && isStreaming`
- **Display Format:** Internationalized via `t("chat:reasoning.seconds", { count })`
- **Visibility:** Elapsed time only displays after first tick (when `elapsed > 0`)

**Collapse/Expand:**

- **User Toggle:** Click the header to collapse/expand content
- **Persistent State:** Respects `reasoningBlockCollapsed` from extension state
- **Visual Cues:** Chevron icon rotates on toggle; content hidden when collapsed

**NOT using progressStatus:** Reasoning has its own dedicated message type (`say: "reasoning"`), independent of the generic progressStatus pattern.

---

## Part 9: Adaptation for Terragon (AG-UI + CUSTOM Events)

### Current State

Terragon's AG-UI message format:

- **AGENT_MESSAGE:** Carries structured tool calls (no `progressStatus`)
- **CUSTOM:** Extensible event family (can attach arbitrary metadata)
- **Challenge:** Tools don't self-describe a status icon or label

### Proposed Extension

#### TypeScript Types

**File:** `packages/shared/src/model/ag-message.ts` (new)

```typescript
/**
 * Tool Progress Status — used for inline progress indication in AG-UI
 *
 * Mirrors Roo Code's pattern: icon (Codicon name) + text (status label)
 */
export const agToolProgressStatusSchema = z.object({
  icon: z.string().optional(),
  text: z.string().optional(),
});

export type AGToolProgressStatus = z.infer<typeof agToolProgressStatusSchema>;

/**
 * AG-UI Message with optional inline progress status
 *
 * Attach to AGENT_MESSAGE when tool is executing and needs visual feedback
 */
export const agMessageWithProgressSchema = z.object({
  // ... existing fields
  progressStatus: agToolProgressStatusSchema.optional(),
});
```

#### CUSTOM Event Extension

**File:** `packages/shared/src/model/event-types.ts` (extend)

```typescript
/**
 * Tool progress event — daemon pushes inline status updates
 *
 * Usage: daemon emits when tool starts/updates:
 *   {
 *     type: "CUSTOM",
 *     discriminant: "terragon.tool.progress",
 *     payload: {
 *       toolCallId: "tool_call_123",
 *       status: { icon: "file-edit", text: "Reading file..." }
 *     }
 *   }
 */
export const toolProgressEventSchema = z.object({
  type: z.literal("CUSTOM"),
  discriminant: z.literal("terragon.tool.progress"),
  payload: z.object({
    toolCallId: z.string(),
    status: agToolProgressStatusSchema,
  }),
});

export type ToolProgressEvent = z.infer<typeof toolProgressEventSchema>;
```

#### Webview Component

**File:** `apps/www/src/components/chat/ToolProgressStatus.tsx` (new)

```typescript
import React from "react"
import { AGToolProgressStatus } from "@terragon/shared"
import { cn } from "@/lib/utils"

interface ToolProgressStatusProps {
	status: AGToolProgressStatus | undefined
	className?: string
}

export const ToolProgressStatus: React.FC<ToolProgressStatusProps> = ({ status, className }) => {
	if (!status?.text) return null

	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			{status.icon && (
				<i
					className={`codicon codicon-${status.icon}`}
					style={{ fontSize: "12px" }}
					title={status.text}
				/>
			)}
			<span className="text-xs text-muted-foreground truncate">{status.text}</span>
		</div>
	)
}
```

#### Usage in Chat Row

**File:** `apps/www/src/components/chat/ChatMessageRow.tsx` (extend)

```typescript
// When rendering a tool call in progress:
<ToolUseBlockHeader>
	<span>{toolName}</span>
	{/* Render inline progress if available */}
	<ToolProgressStatus status={message.progressStatus} className="ml-auto" />
</ToolUseBlockHeader>
```

### Edge Cases & Risks

| Risk                                               | Mitigation                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Invalid icon name** (e.g., `"nonexistent-icon"`) | Browser renders empty icon silently; fallback: omit icon, only show text                                   |
| **progressStatus stale after reconnect**           | Daemon re-sends last status in resume context, or UI times out stale status after 30s inactivity           |
| **Icon name collisions**                           | Codicon namespace is flat; prefix custom icons (e.g., `"terragon-custom-X"`) or use VSCode built-ins only  |
| **Text overflow in narrow UI**                     | Apply `truncate` and `max-w-[200px]` on status text span                                                   |
| **Simultaneous multi-tool progress**               | Each tool has its own `toolCallId`; UI renders per-tool indicators independently                           |
| **Performance on high-frequency updates**          | Debounce daemon emissions: skip updates arriving <100ms apart; send terminal "completed" event to finalize |

---

## Summary

### Key Findings

1. **Roo's Pattern:** `progressStatus: { icon?: string, text?: string }` is an optional field on `ClineMessage`, attached during streaming.
2. **Agent-Side:** Tools optionally pass `progressStatus` to `askApproval()` when seeking user permission; no centralized factory.
3. **Webview Rendering:** `CodeAccordion` component renders icon + text inline in header (right-aligned). Icon uses VSCode Codicon class interpolation (no validation).
4. **Precedence:** Diff stats (added/removed lines) override progressStatus in the rendering hierarchy.
5. **Not Systematic:** Roo treats progressStatus as a capability, not a standard feature — most tools don't use it.

### Terragon Adaptation Strategy

- Extend AG-UI message types with optional `progressStatus` field
- Define a `CUSTOM` event family (`terragon.tool.progress`) for daemon-pushed updates
- Build a reusable `<ToolProgressStatus>` component mirroring Roo's CodeAccordion pattern
- Enumerate VSCode Codicon names in tool specs; validate at render time
- Handle stale/invalid status gracefully: render text only, omit broken icons

### Copy-Adaptable Pattern

The core pattern is **remarkably simple:**

```tsx
{
  status?.text && (
    <>
      {status.icon && <span className={`codicon codicon-${status.icon}`} />}
      <span>{status.text}</span>
    </>
  );
}
```

This single conditional can be dropped into any UI that needs inline tool progress, provided:

- Message type carries the `status` object
- Icon names are validated against VSCode Codicon registry
- Text is short (< 30 chars recommended) to avoid layout shifts

---

**End of Report**
