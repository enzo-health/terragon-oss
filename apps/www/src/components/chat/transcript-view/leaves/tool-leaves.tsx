"use client";

import {
  FilePen,
  FileText,
  FolderTree,
  Globe,
  type LucideIcon,
  Search,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { Task, TaskIcon, TaskItem, TaskLabel } from "@/components/ai/task";
import {
  Tool,
  ToolArgument,
  ToolBlock,
  ToolContent,
  ToolError,
  ToolIcon,
  ToolLabel,
  ToolName,
  ToolSubtitle,
  ToolTrigger,
} from "@/components/ai/tool";
import { cn } from "@/lib/utils";
import type { ToolCallStatus } from "../../transcript-store";
import { toolViewProps } from "./tool-view-props";
import { getToolVerb, summarizeToolResult } from "../../tools/utils";
import type { Leaf } from "../leaf-props";

function verbStatus(status: ToolCallStatus): "pending" | "completed" | "error" {
  if (status === "error") return "error";
  if (status === "success") return "completed";
  return "pending";
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Edit: FilePen,
  Write: FilePen,
  MultiEdit: FilePen,
  Read: FileText,
  Grep: Search,
  Glob: Search,
  LS: FolderTree,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Users,
};

export const ToolLeaf: Leaf<"tool"> = ({ item }) => {
  const active = item.status === "running" || item.status === "pending";
  const failed = item.isError || item.status === "error";
  const { name, preview, state, stream, resultText, errorText, defaultOpen } =
    toolViewProps({
      toolName: item.name,
      argsText: item.argsText,
      result: item.result ?? undefined,
      active,
      failed,
    });
  const [manualOpen, setManualOpen] = useState(false);
  const open = defaultOpen || manualOpen;
  const receipt =
    item.result !== null && !failed
      ? `${getToolVerb(name, verbStatus(item.status))} · ${summarizeToolResult(
          item.result,
        )}`
      : getToolVerb(name, verbStatus(item.status));
  const Icon = TOOL_ICONS[name] ?? Wrench;

  return (
    <Tool
      className="my-1"
      state={state}
      open={open}
      onOpenChange={setManualOpen}
    >
      <ToolTrigger>
        <ToolIcon>
          <Icon />
        </ToolIcon>
        <ToolName>{name || "Tool"}</ToolName>
        {preview ? <ToolLabel>{preview}</ToolLabel> : null}
      </ToolTrigger>
      <ToolContent keepMounted>
        <Task>
          <TaskItem>
            <TaskIcon />
            <TaskLabel>{receipt}</TaskLabel>
          </TaskItem>
        </Task>
        {stream.text ? (
          <>
            <ToolSubtitle>Input</ToolSubtitle>
            <ToolArgument
              value={stream.text}
              state={stream.streaming ? "streaming" : "complete"}
            />
          </>
        ) : null}
        {state !== "error" && resultText ? (
          <>
            <ToolSubtitle>Output</ToolSubtitle>
            <ToolBlock>{resultText}</ToolBlock>
          </>
        ) : null}
        {errorText ? <ToolError>{errorText}</ToolError> : null}
      </ToolContent>
    </Tool>
  );
};

function terminalState(
  exitCode: number | null,
): "running" | "success" | "error" {
  if (exitCode === null) return "running";
  return exitCode === 0 ? "success" : "error";
}

export const TerminalLeaf: Leaf<"terminal"> = ({ item }) => {
  const state = terminalState(item.exitCode);
  const [manualOpen, setManualOpen] = useState(false);
  const open = state === "running" || manualOpen;
  const body = item.chunks.map((chunk) => chunk.text).join("");

  return (
    <Tool
      className="my-1"
      state={state}
      open={open}
      onOpenChange={setManualOpen}
    >
      <ToolTrigger>
        <ToolIcon>
          <Terminal />
        </ToolIcon>
        <ToolName>Terminal</ToolName>
        <ToolLabel>
          {item.exitCode === null ? "Running" : `Exit ${item.exitCode}`}
        </ToolLabel>
      </ToolTrigger>
      <ToolContent keepMounted>
        {body ? (
          <pre
            data-slot="terminal-body"
            className={cn(
              "max-h-80 overflow-auto rounded bg-surface-elevated ring ring-border p-3",
              "text-sm font-mono whitespace-pre-wrap wrap-break-word",
              state === "error" ? "text-destructive" : "text-foreground",
            )}
          >
            {item.chunks.map((chunk, index) => (
              <span
                key={`${chunk.streamSeq}-${index}`}
                className={
                  chunk.stream === "stderr"
                    ? "text-destructive"
                    : chunk.stream === "interaction"
                      ? "text-muted-foreground"
                      : undefined
                }
              >
                {chunk.text}
              </span>
            ))}
          </pre>
        ) : (
          <ToolSubtitle>No output</ToolSubtitle>
        )}
      </ToolContent>
    </Tool>
  );
};

function delegationState(
  status: ToolCallStatus,
): "running" | "success" | "error" {
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "running";
}

export const DelegationLeaf: Leaf<"delegation"> = ({ item }) => {
  const state = delegationState(item.status);
  const [manualOpen, setManualOpen] = useState(false);
  const open = state === "running" || manualOpen;

  return (
    <Tool
      className="my-1"
      state={state}
      open={open}
      onOpenChange={setManualOpen}
    >
      <ToolTrigger>
        <ToolIcon>
          <Users />
        </ToolIcon>
        <ToolName>{item.agentName ?? "Sub-agent"}</ToolName>
        <ToolLabel>
          {state === "running"
            ? "Delegating"
            : state === "error"
              ? "Failed"
              : "Done"}
        </ToolLabel>
      </ToolTrigger>
      <ToolContent keepMounted>
        {item.activities.length > 0 ? (
          <Task>
            {item.activities.map((activity) => (
              <TaskItem key={activity.seq}>
                <TaskIcon />
                <TaskLabel>{activity.text}</TaskLabel>
              </TaskItem>
            ))}
          </Task>
        ) : (
          <ToolSubtitle>No activity yet</ToolSubtitle>
        )}
      </ToolContent>
    </Tool>
  );
};
