"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { parse } from "partial-json";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

type ToolState = "pending" | "approval" | "running" | "success" | "error";

type ToolProps = Collapsible.Root.Props & {
  state?: ToolState;
};

export function Tool({ state, className, ...props }: ToolProps) {
  return (
    <Collapsible.Root
      data-slot="tool"
      data-state={state}
      className={cn(
        "group/tool flex flex-col rounded-outer bg-surface border border-border",
        "transition-[border-color,box-shadow] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
        "animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]",
        "data-[state=approval]:ring-2",
        "data-[state=approval]:ring-primary/40",
        "data-[state=approval]:border-primary/60",
        "data-[state=running]:border-inflight/60",
        "data-[state=running]:ring-2",
        "data-[state=running]:ring-inflight/40",
        "data-[state=error]:border-destructive/60",
        "data-[state=error]:ring-2",
        "data-[state=error]:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export function ToolTrigger({
  className,
  children,
  ...props
}: Collapsible.Trigger.Props) {
  return (
    <Collapsible.Trigger
      data-slot="tool-trigger"
      className={cn(
        "flex w-full items-center gap-2 cursor-pointer select-none text-left bg-transparent",
        "rounded-outer px-4 py-3 text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        "transition-colors",
        "group-data-[state=error]/tool:text-destructive group-data-[state=error]/tool:hover:text-destructive",
        className,
      )}
      {...props}
    >
      {children}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={cn(
          "ml-auto size-4 shrink-0 transition-transform duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
          "group-data-open/tool:rotate-90",
        )}
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Collapsible.Trigger>
  );
}

export function ToolIcon({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tool-icon"
      aria-hidden
      className={cn(
        "size-4 grid place-items-center shrink-0",
        "[&_svg]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center",
          "transition-[opacity,transform,filter] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
          "opacity-100 scale-100 blur-0",
          "group-data-[state=running]/tool:opacity-0 group-data-[state=running]/tool:scale-90 group-data-[state=running]/tool:blur-[2px]",
          "group-data-[state=success]/tool:opacity-0 group-data-[state=success]/tool:scale-90 group-data-[state=success]/tool:blur-[2px]",
        )}
      >
        {children}
      </span>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cn(
          "col-start-1 row-start-1 animate-spin",
          "transition-[opacity,transform,filter] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
          "opacity-0 scale-90 blur-[2px]",
          "group-data-[state=running]/tool:opacity-100 group-data-[state=running]/tool:scale-100 group-data-[state=running]/tool:blur-0",
        )}
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cn(
          "col-start-1 row-start-1 text-muted-foreground/70",
          "transition-[opacity,transform,filter] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
          "opacity-0 scale-90 blur-[2px]",
          "group-data-[state=success]/tool:opacity-100 group-data-[state=success]/tool:scale-100 group-data-[state=success]/tool:blur-0",
        )}
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

export function ToolName({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tool-name"
      className={cn(
        "min-w-0 shrink truncate font-mono text-foreground text-sm",
        "group-data-[state=error]/tool:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function ToolLabel({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tool-label"
      className={cn(
        "min-w-0 truncate text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ToolContent({
  className,
  children,
  ...props
}: Collapsible.Panel.Props) {
  return (
    <Collapsible.Panel
      data-slot="tool-content"
      className={cn(
        "overflow-hidden",
        "h-(--collapsible-panel-height)",
        "transition-[height] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
        "data-starting-style:h-0 data-ending-style:h-0",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 px-4 pt-1.5 pb-3">{children}</div>
    </Collapsible.Panel>
  );
}

export function ToolSubtitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tool-subtitle"
      className={cn("text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ToolBlock({
  className,
  ...props
}: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="tool-block"
      className={cn(
        "max-h-64 overflow-auto",
        "rounded bg-surface-elevated ring ring-border p-3",
        "text-sm font-mono text-foreground tabular-nums",
        "whitespace-pre-wrap wrap-break-word",
        className,
      )}
      {...props}
    />
  );
}

export function ToolError({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tool-error"
      className={cn(
        "hidden group-data-[state=error]/tool:block",
        "rounded bg-destructive/10 ring ring-destructive/30 p-3",
        "text-sm text-destructive",
        className,
      )}
      {...props}
    />
  );
}

type ToolArgumentProps = Omit<React.ComponentProps<"div">, "children"> & {
  value: string;
  state?: "streaming" | "complete";
};

function safeParse(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return parse(value);
  } catch {
    return undefined;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function ToolArgument({
  value,
  state,
  className,
  ...props
}: ToolArgumentProps) {
  // Memoize the partial-json parse so re-renders that don't change `value`
  // (sibling state updates) skip re-parsing the whole buffer. During streaming
  // `value` grows every chunk, so that case still re-parses by design.
  const { parsed, isObject, entries } = useMemo(() => {
    const value_ = safeParse(value);
    const obj =
      value_ !== null && typeof value_ === "object" && !Array.isArray(value_);
    return {
      parsed: value_,
      isObject: obj,
      entries: obj ? Object.entries(value_ as Record<string, unknown>) : [],
    };
  }, [value]);

  return (
    <div
      data-slot="tool-argument"
      data-state={state}
      className={cn(
        "rounded bg-surface-elevated ring ring-border overflow-hidden",
        "text-sm font-mono",
        className,
      )}
      {...props}
    >
      {isObject && entries.length > 0 && (
        <div className="flex flex-col">
          {entries.map(([key, val]) => {
            const formatted = formatValue(val);
            return (
              <div
                key={key}
                data-slot="tool-argument-row"
                className="grid grid-cols-[max-content_1fr] items-start gap-3 px-3 py-1.5 border-t border-border first:border-t-0"
              >
                <span
                  data-slot="tool-argument-key"
                  className="text-muted-foreground"
                >
                  {key}
                </span>
                <span
                  data-slot="tool-argument-value"
                  className="min-w-0 text-foreground wrap-break-word whitespace-pre-wrap"
                >
                  {formatted}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!isObject && parsed !== undefined && (
        <pre
          data-slot="tool-argument-raw"
          className="max-h-64 overflow-auto p-3 whitespace-pre-wrap wrap-break-word"
        >
          {formatValue(parsed)}
        </pre>
      )}
      {parsed === undefined && value.trim() && (
        <pre
          data-slot="tool-argument-raw"
          className="max-h-64 overflow-auto p-3 whitespace-pre-wrap wrap-break-word"
        >
          {value}
        </pre>
      )}
    </div>
  );
}
