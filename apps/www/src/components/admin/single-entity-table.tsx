import { ReactNode } from "react";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import Link from "next/link";

// Common rendering patterns
export type LinkResult = {
  type: "link";
  label: string;
  href: string;
  className?: string;
};
export type DateResult = { type: "date"; value: Date };
export type JsonResult = { type: "json"; value: any };
export type HiddenResult = { type: "hidden" };

export type RenderKeyResult =
  | ReactNode
  | undefined
  | LinkResult
  | DateResult
  | JsonResult
  | HiddenResult;

function isLinkResult(result: any): result is LinkResult {
  return result?.type === "link";
}

function isDateResult(result: any): result is DateResult {
  return result?.type === "date";
}

function isJsonResult(result: any): result is JsonResult {
  return result?.type === "json";
}

function isHiddenResult(result: any): result is HiddenResult {
  return result?.type === "hidden";
}

export interface SingleEntityTableProps<T> {
  entity: T;
  rowKeys: (keyof T | string)[];
  renderKey?: (key: string) => RenderKeyResult;
  className?: string;
  getLabel?: (key: string) => string;
  skipKeys?: string[];
}

export function SingleEntityTable<T extends Record<string, any>>({
  entity,
  rowKeys,
  renderKey,
  className,
  getLabel,
  skipKeys = [],
}: SingleEntityTableProps<T>) {
  return (
    <Table className={className}>
      <TableBody>
        {rowKeys
          .filter((key) => !skipKeys.includes(String(key)))
          .map((key) => {
            const keyString = String(key);

            // Get custom render result if provided
            const customRender = renderKey?.(keyString);

            // Handle hidden type
            if (isHiddenResult(customRender)) {
              return null;
            }

            // Determine the label
            const label = getLabel?.(keyString) ?? keyString;

            // Determine the value to display
            let displayValue: ReactNode;

            if (customRender !== undefined) {
              if (isLinkResult(customRender)) {
                displayValue = (
                  <Link
                    href={customRender.href}
                    className={
                      customRender.className ??
                      "text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                    }
                  >
                    {customRender.label}
                  </Link>
                );
              } else if (isDateResult(customRender)) {
                displayValue = (
                  <span className="tabular-nums">
                    {customRender.value.toLocaleString()}
                  </span>
                );
              } else if (isJsonResult(customRender)) {
                displayValue = (
                  <pre className="overflow-x-auto rounded-xl border border-border bg-canvas p-3 font-mono text-xs leading-relaxed">
                    {JSON.stringify(customRender.value, null, 2)}
                  </pre>
                );
              } else {
                // Custom ReactNode
                displayValue = customRender;
              }
            } else {
              // Default rendering
              const value = entity[key as keyof T];
              if (value === null) {
                displayValue = (
                  <span className="font-mono text-muted-foreground">null</span>
                );
              } else if (value === undefined) {
                displayValue = (
                  <span className="font-mono text-muted-foreground">
                    undefined
                  </span>
                );
              } else if (
                Object.prototype.toString.call(value) === "[object Date]"
              ) {
                displayValue = (
                  <span className="tabular-nums">
                    {format(value as Date, "PPP p")}
                  </span>
                );
              } else if (typeof value === "boolean") {
                displayValue = (
                  <span className="font-mono tabular-nums">
                    {JSON.stringify(value)}
                  </span>
                );
              } else if (typeof value === "object") {
                displayValue = (
                  <pre className="max-w-xl overflow-auto rounded-xl border border-border bg-canvas p-3 font-mono text-xs leading-relaxed">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                );
              } else {
                displayValue = String(value);
              }
            }

            return (
              <TableRow key={keyString}>
                <TableCell className="w-48 align-top text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  {label}
                </TableCell>
                <TableCell className="align-top text-foreground">
                  {displayValue}
                </TableCell>
              </TableRow>
            );
          })}
      </TableBody>
    </Table>
  );
}
