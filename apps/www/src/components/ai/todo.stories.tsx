import type { Story, StoryDefault } from "@ladle/react";
import {
  Todo,
  TodoContent,
  TodoHeader,
  TodoItem,
  TodoItemIcon,
  TodoItemLabel,
  TodoList,
  TodoTitle,
  TodoTrigger,
} from "./todo";

type Entry = {
  status: "pending" | "progress" | "completed";
  label: string;
};

const ENTRIES: Entry[] = [
  { status: "completed", label: "Read agent/orchestrator.ts" },
  { status: "completed", label: "Reproduce the hibernation test failure" },
  { status: "progress", label: "Route null handles into the resume path" },
  { status: "pending", label: "Add a regression test for stale sessions" },
  { status: "pending", label: "Run pnpm -C packages/sandbox test" },
];

const LONG_ENTRIES: Entry[] = [
  {
    status: "completed",
    label:
      "Audit every call site of resolveSandbox() across apps/www/src/agent and packages/sandbox to confirm none of them already guard against a hibernated E2B session returning undefined",
  },
  {
    status: "progress",
    label:
      "Rework the orchestrator so a null sandbox handle is treated as a recoverable resume signal instead of surfacing to the user as a hard sandbox-not-found failure",
  },
  {
    status: "pending",
    label:
      "Backfill an integration test that hibernates the session mid-turn and asserts the follow-up turn resumes cleanly without a user-visible error banner",
  },
];

export const AllStatuses: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo defaultOpen>
        <TodoHeader>
          <TodoTitle>Plan (2/5)</TodoTitle>
        </TodoHeader>
        <TodoList className="pb-2">
          {ENTRIES.map((entry) => (
            <TodoItem key={entry.label} status={entry.status}>
              <TodoItemIcon />
              <TodoItemLabel>{entry.label}</TodoItemLabel>
            </TodoItem>
          ))}
        </TodoList>
      </Todo>
    </div>
  );
};

export const Collapsed: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo>
        <TodoHeader>
          <TodoTitle>Plan (2/5)</TodoTitle>
          <TodoTrigger className="ml-auto cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Show
          </TodoTrigger>
        </TodoHeader>
        <TodoContent>
          <TodoList>
            {ENTRIES.map((entry) => (
              <TodoItem key={entry.label} status={entry.status}>
                <TodoItemIcon />
                <TodoItemLabel>{entry.label}</TodoItemLabel>
              </TodoItem>
            ))}
          </TodoList>
        </TodoContent>
      </Todo>
    </div>
  );
};

export const Expanded: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo defaultOpen>
        <TodoHeader>
          <TodoTitle>Plan (2/5)</TodoTitle>
          <TodoTrigger className="ml-auto cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Hide
          </TodoTrigger>
        </TodoHeader>
        <TodoContent>
          <TodoList>
            {ENTRIES.map((entry) => (
              <TodoItem key={entry.label} status={entry.status}>
                <TodoItemIcon />
                <TodoItemLabel>{entry.label}</TodoItemLabel>
              </TodoItem>
            ))}
          </TodoList>
        </TodoContent>
      </Todo>
    </div>
  );
};

export const AllCompleted: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo defaultOpen>
        <TodoHeader>
          <TodoTitle>Plan (3/3)</TodoTitle>
        </TodoHeader>
        <TodoList className="pb-2">
          {ENTRIES.slice(0, 3).map((entry) => (
            <TodoItem key={entry.label} status="completed">
              <TodoItemIcon />
              <TodoItemLabel>{entry.label}</TodoItemLabel>
            </TodoItem>
          ))}
        </TodoList>
      </Todo>
    </div>
  );
};

export const Empty: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo defaultOpen>
        <TodoHeader>
          <TodoTitle>Plan (0/0)</TodoTitle>
        </TodoHeader>
        <TodoList className="pb-2" />
      </Todo>
    </div>
  );
};

export const LongLabelsOverflow: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Todo defaultOpen>
        <TodoHeader>
          <TodoTitle>Plan (1/3)</TodoTitle>
        </TodoHeader>
        <TodoList className="pb-2">
          {LONG_ENTRIES.map((entry) => (
            <TodoItem key={entry.label} status={entry.status}>
              <TodoItemIcon />
              <TodoItemLabel>{entry.label}</TodoItemLabel>
            </TodoItem>
          ))}
        </TodoList>
      </Todo>
    </div>
  );
};

export default {
  title: "ai/todo",
} satisfies StoryDefault;
