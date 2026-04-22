# Bolt.new: Artifact + Action List UI Pattern

**Source**: github.com/stackblitz/bolt.new (depth-1 clone)

This document contains the complete, production code for Bolt's real-time action status UI. The pattern uses:

- Nanostores for reactive state (MapStore for action state)
- Framer Motion for collapse/expand animations
- UnoCSS icon system (@iconify-json/ph for status icons, svg-spinners for spinning loader)
- TypeScript discriminated unions for action types (file vs shell)

---

## File: /app/components/chat/Artifact.tsx

```tsx
import { useStore } from "@nanostores/react";
import { AnimatePresence, motion } from "framer-motion";
import { computed } from "nanostores";
import { memo, useEffect, useRef, useState } from "react";
import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
} from "shiki";
import type { ActionState } from "~/lib/runtime/action-runner";
import { workbenchStore } from "~/lib/stores/workbench";
import { classNames } from "~/utils/classNames";
import { cubicEasingFn } from "~/utils/easings";

const highlighterOptions = {
  langs: ["shell"],
  themes: ["light-plus", "dark-plus"],
};

const shellHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> =
  import.meta.hot?.data.shellHighlighter ??
  (await createHighlighter(highlighterOptions));

if (import.meta.hot) {
  import.meta.hot.data.shellHighlighter = shellHighlighter;
}

interface ArtifactProps {
  messageId: string;
}

export const Artifact = memo(({ messageId }: ArtifactProps) => {
  const userToggledActions = useRef(false);
  const [showActions, setShowActions] = useState(false);

  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[messageId];

  const actions = useStore(
    computed(artifact.runner.actions, (actions) => {
      return Object.values(actions);
    }),
  );

  const toggleActions = () => {
    userToggledActions.current = true;
    setShowActions(!showActions);
  };

  useEffect(() => {
    if (actions.length && !showActions && !userToggledActions.current) {
      setShowActions(true);
    }
  }, [actions]);

  return (
    <div className="artifact border border-bolt-elements-borderColor flex flex-col overflow-hidden rounded-lg w-full transition-border duration-150">
      <div className="flex">
        <button
          className="flex items-stretch bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover w-full overflow-hidden"
          onClick={() => {
            const showWorkbench = workbenchStore.showWorkbench.get();
            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
        >
          <div className="px-5 p-3.5 w-full text-left">
            <div className="w-full text-bolt-elements-textPrimary font-medium leading-5 text-sm">
              {artifact?.title}
            </div>
            <div className="w-full w-full text-bolt-elements-textSecondary text-xs mt-0.5">
              Click to open Workbench
            </div>
          </div>
        </button>
        <div className="bg-bolt-elements-artifacts-borderColor w-[1px]" />
        <AnimatePresence>
          {actions.length && (
            <motion.button
              initial={{ width: 0 }}
              animate={{ width: "auto" }}
              exit={{ width: 0 }}
              transition={{ duration: 0.15, ease: cubicEasingFn }}
              className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
              onClick={toggleActions}
            >
              <div className="p-4">
                <div
                  className={
                    showActions ? "i-ph:caret-up-bold" : "i-ph:caret-down-bold"
                  }
                ></div>
              </div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {showActions && actions.length > 0 && (
          <motion.div
            className="actions"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: "0px" }}
            transition={{ duration: 0.15 }}
          >
            <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />
            <div className="p-5 text-left bg-bolt-elements-actions-background">
              <ActionList actions={actions} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

interface ShellCodeBlockProps {
  classsName?: string;
  code: string;
}

function ShellCodeBlock({ classsName, code }: ShellCodeBlockProps) {
  return (
    <div
      className={classNames("text-xs", classsName)}
      dangerouslySetInnerHTML={{
        __html: shellHighlighter.codeToHtml(code, {
          lang: "shell",
          theme: "dark-plus",
        }),
      }}
    ></div>
  );
}

interface ActionListProps {
  actions: ActionState[];
}

const actionVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const ActionList = memo(({ actions }: ActionListProps) => {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <ul className="list-none space-y-2.5">
        {actions.map((action, index) => {
          const { status, type, content } = action;
          const isLast = index === actions.length - 1;

          return (
            <motion.li
              key={index}
              variants={actionVariants}
              initial="hidden"
              animate="visible"
              transition={{
                duration: 0.2,
                ease: cubicEasingFn,
              }}
            >
              <div className="flex items-center gap-1.5 text-sm">
                <div
                  className={classNames("text-lg", getIconColor(action.status))}
                >
                  {status === "running" ? (
                    <div className="i-svg-spinners:90-ring-with-bg"></div>
                  ) : status === "pending" ? (
                    <div className="i-ph:circle-duotone"></div>
                  ) : status === "complete" ? (
                    <div className="i-ph:check"></div>
                  ) : status === "failed" || status === "aborted" ? (
                    <div className="i-ph:x"></div>
                  ) : null}
                </div>
                {type === "file" ? (
                  <div>
                    Create{" "}
                    <code className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-1 rounded-md">
                      {action.filePath}
                    </code>
                  </div>
                ) : type === "shell" ? (
                  <div className="flex items-center w-full min-h-[28px]">
                    <span className="flex-1">Run command</span>
                  </div>
                ) : null}
              </div>
              {type === "shell" && (
                <ShellCodeBlock
                  classsName={classNames("mt-1", {
                    "mb-3.5": !isLast,
                  })}
                  code={content}
                />
              )}
            </motion.li>
          );
        })}
      </ul>
    </motion.div>
  );
});

function getIconColor(status: ActionState["status"]) {
  switch (status) {
    case "pending": {
      return "text-bolt-elements-textTertiary";
    }
    case "running": {
      return "text-bolt-elements-loader-progress";
    }
    case "complete": {
      return "text-bolt-elements-icon-success";
    }
    case "aborted": {
      return "text-bolt-elements-textSecondary";
    }
    case "failed": {
      return "text-bolt-elements-icon-error";
    }
    default: {
      return undefined;
    }
  }
}
```

**Key features in Artifact.tsx:**

- Line 28–29: `userToggledActions.current` tracks whether user manually toggled (to not auto-expand)
- Line 31–32: `useStore()` + `computed()` pattern: reactive subset of artifact state
- Line 34–38: Nanostores computed store to unwrap Object.values() for display
- Line 45–49: useEffect auto-expands when actions arrive (unless user already toggled)
- Line 68–82: AnimatePresence + motion.button for expand button: width animates 0 → auto
- Line 84–99: motion.div animates height 0 → auto for action list collapse/expand
- Line 152–161: Icon branching by status with color classes applied via getIconColor()
- Line 154: `i-svg-spinners:90-ring-with-bg` = animated spinner (UnoCSS icon class)
- Line 162–174: File actions render path in inline `<code>` tag; shell actions render label

---

## File: /app/types/actions.ts

```ts
export type ActionType = "file" | "shell";

export interface BaseAction {
  content: string;
}

export interface FileAction extends BaseAction {
  type: "file";
  filePath: string;
}

export interface ShellAction extends BaseAction {
  type: "shell";
}

export type BoltAction = FileAction | ShellAction;

export type BoltActionData = BoltAction | BaseAction;
```

**Purpose**: Discriminated union types for actions. Parser emits BoltActionData, runner stores as ActionState (adds status + abort).

---

## File: /app/lib/runtime/action-runner.ts

```ts
import { WebContainer } from "@webcontainer/api";
import { map, type MapStore } from "nanostores";
import * as nodePath from "node:path";
import type { BoltAction } from "~/types/actions";
import { createScopedLogger } from "~/utils/logger";
import { unreachable } from "~/utils/unreachable";
import type { ActionCallbackData } from "./message-parser";

const logger = createScopedLogger("ActionRunner");

export type ActionStatus =
  | "pending"
  | "running"
  | "complete"
  | "aborted"
  | "failed";

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, "failed">;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, "status"> & {
    status: Extract<ActionStatus, "failed">;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<
  Pick<BaseActionState, "status" | "abort" | "executed">
>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, "status"> & { status: "failed"; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();

  actions: ActionsMap = map({});

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: "pending",
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: "aborted" });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: "running" });
    });
  }

  async runAction(data: ActionCallbackData) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return;
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: true });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId);
      })
      .catch((error) => {
        console.error("Action failed:", error);
      });
  }

  async #executeAction(actionId: string) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: "running" });

    try {
      switch (action.type) {
        case "shell": {
          await this.#runShellAction(action);
          break;
        }
        case "file": {
          await this.#runFileAction(action);
          break;
        }
      }

      this.#updateAction(actionId, {
        status: action.abortSignal.aborted ? "aborted" : "complete",
      });
    } catch (error) {
      this.#updateAction(actionId, {
        status: "failed",
        error: "Action failed",
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== "shell") {
      unreachable("Expected shell action");
    }

    const webcontainer = await this.#webcontainer;

    const process = await webcontainer.spawn("jsh", ["-c", action.content], {
      env: { npm_config_yes: true },
    });

    action.abortSignal.addEventListener("abort", () => {
      process.kill();
    });

    process.output.pipeTo(
      new WritableStream({
        write(data) {
          console.log(data);
        },
      }),
    );

    const exitCode = await process.exit;

    logger.debug(`Process terminated with code ${exitCode}`);
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== "file") {
      unreachable("Expected file action");
    }

    const webcontainer = await this.#webcontainer;

    let folder = nodePath.dirname(action.filePath);

    // remove trailing slashes
    folder = folder.replace(/\/+$/g, "");

    if (folder !== ".") {
      try {
        await webcontainer.fs.mkdir(folder, { recursive: true });
        logger.debug("Created folder", folder);
      } catch (error) {
        logger.error("Failed to create folder\n\n", error);
      }
    }

    try {
      await webcontainer.fs.writeFile(action.filePath, action.content);
      logger.debug(`File written ${action.filePath}`);
    } catch (error) {
      logger.error("Failed to write file\n\n", error);
    }
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }
}
```

**State machine details:**

- Line 46–69: `addAction()` creates action with pending status, enqueues status→running via promise chain
- Line 71–96: `runAction()` marks executed=true, chains execution via `#currentExecutionPromise`
- Line 98–122: `#executeAction()` updates status running→complete (or aborted/failed)
- Line 181–185: `#updateAction()` immutably updates MapStore via setKey()
- **Pattern**: Actions queue sequentially via `#currentExecutionPromise` (Promise.then() chain)

---

## File: /app/lib/runtime/message-parser.ts

```ts
import type {
  ActionType,
  BoltAction,
  BoltActionData,
  FileAction,
  ShellAction,
} from "~/types/actions";
import type { BoltArtifactData } from "~/types/artifact";
import { createScopedLogger } from "~/utils/logger";
import { unreachable } from "~/utils/unreachable";

const ARTIFACT_TAG_OPEN = "<boltArtifact";
const ARTIFACT_TAG_CLOSE = "</boltArtifact>";
const ARTIFACT_ACTION_TAG_OPEN = "<boltAction";
const ARTIFACT_ACTION_TAG_CLOSE = "</boltAction>";

const logger = createScopedLogger("MessageParser");

export interface ArtifactCallbackData extends BoltArtifactData {
  messageId: string;
}

export interface ActionCallbackData {
  artifactId: string;
  messageId: string;
  actionId: string;
  action: BoltAction;
}

export type ArtifactCallback = (data: ArtifactCallbackData) => void;
export type ActionCallback = (data: ActionCallbackData) => void;

export interface ParserCallbacks {
  onArtifactOpen?: ArtifactCallback;
  onArtifactClose?: ArtifactCallback;
  onActionOpen?: ActionCallback;
  onActionClose?: ActionCallback;
}

interface ElementFactoryProps {
  messageId: string;
}

type ElementFactory = (props: ElementFactoryProps) => string;

export interface StreamingMessageParserOptions {
  callbacks?: ParserCallbacks;
  artifactElement?: ElementFactory;
}

interface MessageState {
  position: number;
  insideArtifact: boolean;
  insideAction: boolean;
  currentArtifact?: BoltArtifactData;
  currentAction: BoltActionData;
  actionId: number;
}

export class StreamingMessageParser {
  #messages = new Map<string, MessageState>();

  constructor(private _options: StreamingMessageParserOptions = {}) {}

  parse(messageId: string, input: string) {
    let state = this.#messages.get(messageId);

    if (!state) {
      state = {
        position: 0,
        insideAction: false,
        insideArtifact: false,
        currentAction: { content: "" },
        actionId: 0,
      };

      this.#messages.set(messageId, state);
    }

    let output = "";
    let i = state.position;
    let earlyBreak = false;

    while (i < input.length) {
      if (state.insideArtifact) {
        const currentArtifact = state.currentArtifact;

        if (currentArtifact === undefined) {
          unreachable("Artifact not initialized");
        }

        if (state.insideAction) {
          const closeIndex = input.indexOf(ARTIFACT_ACTION_TAG_CLOSE, i);

          const currentAction = state.currentAction;

          if (closeIndex !== -1) {
            currentAction.content += input.slice(i, closeIndex);

            let content = currentAction.content.trim();

            if ("type" in currentAction && currentAction.type === "file") {
              content += "\n";
            }

            currentAction.content = content;

            this._options.callbacks?.onActionClose?.({
              artifactId: currentArtifact.id,
              messageId,

              /**
               * We decrement the id because it's been incremented already
               * when `onActionOpen` was emitted to make sure the ids are
               * the same.
               */
              actionId: String(state.actionId - 1),

              action: currentAction as BoltAction,
            });

            state.insideAction = false;
            state.currentAction = { content: "" };

            i = closeIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
          } else {
            break;
          }
        } else {
          const actionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          if (
            actionOpenIndex !== -1 &&
            (artifactCloseIndex === -1 || actionOpenIndex < artifactCloseIndex)
          ) {
            const actionEndIndex = input.indexOf(">", actionOpenIndex);

            if (actionEndIndex !== -1) {
              state.insideAction = true;

              state.currentAction = this.#parseActionTag(
                input,
                actionOpenIndex,
                actionEndIndex,
              );

              this._options.callbacks?.onActionOpen?.({
                artifactId: currentArtifact.id,
                messageId,
                actionId: String(state.actionId++),
                action: state.currentAction as BoltAction,
              });

              i = actionEndIndex + 1;
            } else {
              break;
            }
          } else if (artifactCloseIndex !== -1) {
            this._options.callbacks?.onArtifactClose?.({
              messageId,
              ...currentArtifact,
            });

            state.insideArtifact = false;
            state.currentArtifact = undefined;

            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            break;
          }
        }
      } else if (input[i] === "<" && input[i + 1] !== "/") {
        let j = i;
        let potentialTag = "";

        while (
          j < input.length &&
          potentialTag.length < ARTIFACT_TAG_OPEN.length
        ) {
          potentialTag += input[j];

          if (potentialTag === ARTIFACT_TAG_OPEN) {
            const nextChar = input[j + 1];

            if (nextChar && nextChar !== ">" && nextChar !== " ") {
              output += input.slice(i, j + 1);
              i = j + 1;
              break;
            }

            const openTagEnd = input.indexOf(">", j);

            if (openTagEnd !== -1) {
              const artifactTag = input.slice(i, openTagEnd + 1);

              const artifactTitle = this.#extractAttribute(
                artifactTag,
                "title",
              ) as string;
              const artifactId = this.#extractAttribute(
                artifactTag,
                "id",
              ) as string;

              if (!artifactTitle) {
                logger.warn("Artifact title missing");
              }

              if (!artifactId) {
                logger.warn("Artifact id missing");
              }

              state.insideArtifact = true;

              const currentArtifact = {
                id: artifactId,
                title: artifactTitle,
              } satisfies BoltArtifactData;

              state.currentArtifact = currentArtifact;

              this._options.callbacks?.onArtifactOpen?.({
                messageId,
                ...currentArtifact,
              });

              const artifactFactory =
                this._options.artifactElement ?? createArtifactElement;

              output += artifactFactory({ messageId });

              i = openTagEnd + 1;
            } else {
              earlyBreak = true;
            }

            break;
          } else if (!ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
            output += input.slice(i, j + 1);
            i = j + 1;
            break;
          }

          j++;
        }

        if (j === input.length && ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
          break;
        }
      } else {
        output += input[i];
        i++;
      }

      if (earlyBreak) {
        break;
      }
    }

    state.position = i;

    return output;
  }

  reset() {
    this.#messages.clear();
  }

  #parseActionTag(
    input: string,
    actionOpenIndex: number,
    actionEndIndex: number,
  ) {
    const actionTag = input.slice(actionOpenIndex, actionEndIndex + 1);

    const actionType = this.#extractAttribute(actionTag, "type") as ActionType;

    const actionAttributes = {
      type: actionType,
      content: "",
    };

    if (actionType === "file") {
      const filePath = this.#extractAttribute(actionTag, "filePath") as string;

      if (!filePath) {
        logger.debug("File path not specified");
      }

      (actionAttributes as FileAction).filePath = filePath;
    } else if (actionType !== "shell") {
      logger.warn(`Unknown action type '${actionType}'`);
    }

    return actionAttributes as FileAction | ShellAction;
  }

  #extractAttribute(tag: string, attributeName: string): string | undefined {
    const match = tag.match(new RegExp(`${attributeName}="([^"]*)"`, "i"));
    return match ? match[1] : undefined;
  }
}

const createArtifactElement: ElementFactory = (props) => {
  const elementProps = [
    'class="__boltArtifact__"',
    ...Object.entries(props).map(([key, value]) => {
      return `data-${camelToDashCase(key)}=${JSON.stringify(value)}`;
    }),
  ];

  return `<div ${elementProps.join(" ")}></div>`;
};

function camelToDashCase(input: string) {
  return input.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}
```

**Parser flow:**

- Line 59: `parse(messageId, input)` is called incrementally as Claude streams (stateful streaming)
- Line 60–72: Initialize state for messageId if not exists
- Line 79–156: State machine: routes through artifact/action parsing
- Line 101–114: On `</boltAction>` close: emit onActionClose callback
- Line 124–145: On `<boltAction>` open: emit onActionOpen callback
- Line 133: `state.actionId++` is post-increment; callback gets the new ID
- Line 111: `state.actionId - 1` in onActionClose because ID was already incremented in onActionOpen
- Line 241–264: `#parseActionTag()` extracts type and filePath attributes
- **Usage**: Called from BaseChat/message handler; callbacks fire onArtifactOpen, onActionOpen, onActionClose

---

## File: /app/lib/stores/workbench.ts (excerpt)

```ts
import {
  atom,
  map,
  type MapStore,
  type ReadableAtom,
  type WritableAtom,
} from "nanostores";
import type {
  EditorDocument,
  ScrollPosition,
} from "~/components/editor/codemirror/CodeMirrorEditor";
import { ActionRunner } from "~/lib/runtime/action-runner";
import type {
  ActionCallbackData,
  ArtifactCallbackData,
} from "~/lib/runtime/message-parser";
import { webcontainer } from "~/lib/webcontainer";
import type { ITerminal } from "~/types/terminal";
import { unreachable } from "~/utils/unreachable";
import { EditorStore } from "./editor";
import { FilesStore, type FileMap } from "./files";
import { PreviewsStore } from "./previews";
import { TerminalStore } from "./terminal";

export interface ArtifactState {
  id: string;
  title: string;
  closed: boolean;
  runner: ActionRunner;
}

export type ArtifactUpdateState = Pick<ArtifactState, "title" | "closed">;

type Artifacts = MapStore<Record<string, ArtifactState>>;

export type WorkbenchViewType = "code" | "preview";

export class WorkbenchStore {
  #previewsStore = new PreviewsStore(webcontainer);
  #filesStore = new FilesStore(webcontainer);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(webcontainer);

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> =
    import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> =
    import.meta.hot?.data.currentView ?? atom("code");
  unsavedFiles: WritableAtom<Set<string>> =
    import.meta.hot?.data.unsavedFiles ?? atom(new Set<string>());
  modifiedFiles = new Set<string>();
  artifactIdList: string[] = [];

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
    }
  }

  // ...

  addArtifact({ messageId, title, id }: ArtifactCallbackData) {
    const artifact = this.#getArtifact(messageId);

    if (artifact) {
      return;
    }

    if (!this.artifactIdList.includes(messageId)) {
      this.artifactIdList.push(messageId);
    }

    this.artifacts.setKey(messageId, {
      id,
      title,
      closed: false,
      runner: new ActionRunner(webcontainer),
    });
  }

  updateArtifact(
    { messageId }: ArtifactCallbackData,
    state: Partial<ArtifactUpdateState>,
  ) {
    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(messageId, { ...artifact, ...state });
  }

  async addAction(data: ActionCallbackData) {
    const { messageId } = data;

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      unreachable("Artifact not found");
    }

    artifact.runner.addAction(data);
  }

  async runAction(data: ActionCallbackData) {
    const { messageId } = data;

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      unreachable("Artifact not found");
    }

    artifact.runner.runAction(data);
  }

  #getArtifact(id: string) {
    const artifacts = this.artifacts.get();
    return artifacts[id];
  }
}

export const workbenchStore = new WorkbenchStore();
```

**Store structure:**

- Line 13–17: ArtifactState binds title, closed, and ActionRunner instance
- Line 32: `artifacts` is MapStore<Record<messageId, ArtifactState>>
- Line 217–234: addArtifact/updateArtifact use setKey() for reactivity
- Line 246–268: addAction/runAction delegate to artifact.runner (ActionRunner instance)
- **Pattern**: Each artifact has its own ActionRunner; actions keyed by actionId within runner.actions MapStore

---

## File: /app/types/artifact.ts

```ts
export interface BoltArtifactData {
  id: string;
  title: string;
}
```

---

## Icon Classes (UnoCSS)

```
i-svg-spinners:90-ring-with-bg   → animated 90-degree ring (svg-spinners pkg)
i-ph:caret-up-bold              → phosphor bold caret-up icon
i-ph:caret-down-bold            → phosphor bold caret-down icon
i-ph:circle-duotone             → phosphor duotone circle (pending)
i-ph:check                       → phosphor check mark (success)
i-ph:x                          → phosphor X (failure)
```

**Setup**: `@iconify-json/ph` + `@iconify-json/svg-spinners` in package.json; UnoCSS renders via CSS classes.

---

## Animation Variants (Framer Motion)

```ts
// Action list item reveal
const actionVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

// Expand/collapse button width
motion.button with initial={{ width: 0 }}, animate={{ width: 'auto' }}, transition={{ duration: 0.15 }}

// Artifact actions container height
motion.div with initial={{ height: 0 }}, animate={{ height: 'auto' }}, exit={{ height: '0px' }}, transition={{ duration: 0.15 }}
```

---

## How to Adapt to Terragon

1. **Icon library**: Replace UnoCSS icons with your icon system (or install @iconify-json/ph + @iconify-json/svg-spinners)
2. **State structure**: Your ActionRunner → equivalent in your agent system (looks like Bolt's is WebContainer execution; yours will be daemon/sandbox)
3. **Parser**: Adapt StreamingMessageParser XML tags to your Claude output format (Bolt uses `<boltArtifact>` and `<boltAction>`)
4. **Nanostores**: Use your existing state management (Jotai) but the pattern (MapStore of actions keyed by actionId) is reusable
5. **Colors**: Replace `text-bolt-*` Tailwind tokens with your color scale
6. **Shell highlighter**: Shiki is optional; you can use any code highlighter or remove it

**Key insight**: The state machine (pending → running → complete/failed/aborted) lives in the action-runner and is purely reactive via Nanostores. The UI is a dumb view of that state.
