import { AllToolParts } from "@leo/shared";
import { useTheme } from "next-themes";
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { getAgentColorClass } from "./agent-colors";
import { ansiToHtml } from "./utils";

export function GenericToolPart({
  toolName,
  toolArg,
  toolStatus,
  children,
  toolColor,
  toolArgSuffix,
}: {
  toolName: React.ReactNode;
  toolArg: string | null;
  toolStatus: AllToolParts["status"];
  children: React.ReactNode;
  toolColor?: string;
  toolArgSuffix?: React.ReactNode;
}) {
  const colorClass = getAgentColorClass(toolColor);
  return (
    <div className="flex gap-2 items-start min-w-0">
      <span className="h-5 flex items-center">
        <span
          className={cn("shrink-0 size-2 rounded-full inline-block", {
            "bg-green-500": toolStatus === "completed",
            "bg-red-500": toolStatus === "error",
            "bg-muted-foreground animate-blink": toolStatus === "pending",
          })}
          aria-hidden="true"
        />
      </span>
      <div className="font-mono text-sm flex flex-col flex-1 min-w-0">
        {!toolArg ? (
          <div className="break-words line-clamp-3">
            <span
              className={cn(
                "font-semibold px-1 rounded-sm",
                colorClass ? "!text-white " + colorClass : "!text-foreground",
              )}
            >
              {toolName}
            </span>
            {toolArgSuffix}
          </div>
        ) : (
          <div className="break-words line-clamp-3">
            <span
              className={cn(
                "font-semibold px-1 rounded-sm",
                colorClass ? "!text-white " + colorClass : "!text-foreground",
              )}
            >
              {toolName}
            </span>
            <span className="!text-foreground font-semibold">(</span>
            <span className="!text-foreground font-medium">{toolArg}</span>
            <span className="!text-foreground font-semibold">)</span>
            {toolArgSuffix}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function GenericToolPartContent({
  children,
  toolStatus,
  className,
  singleColumn = false,
}: {
  children: React.ReactNode;
  toolStatus: AllToolParts["status"];
  className?: string;
  singleColumn?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-1.5 font-mono text-sm min-w-0 overflow-hidden",
        {
          "text-red-700": toolStatus === "error",
          "text-muted-foreground": toolStatus === "pending",
          "grid-cols-[auto]": singleColumn,
        },
        className,
      )}
    >
      {children}
    </div>
  );
}

function isLongLine(line: string) {
  return line.length > 500;
}

export function GenericToolPartContentOneLine({
  children,
  toolStatus,
  singleColumn = false,
}: {
  children: React.ReactNode;
  toolStatus: AllToolParts["status"];
  singleColumn?: boolean;
}) {
  const contentString = typeof children === "string" ? children : null;
  const isLongContent = contentString && isLongLine(contentString);
  if (!isLongContent) {
    return (
      <GenericToolPartContent
        toolStatus={toolStatus}
        singleColumn={singleColumn}
      >
        <GenericToolPartContentRow
          index={0}
          className={cn({
            "animate-pulse": toolStatus === "pending",
          })}
          singleColumn={singleColumn}
        >
          {children}
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }
  return (
    <GenericToolPartContent toolStatus={toolStatus} singleColumn={singleColumn}>
      <GenericToolPartContentResultWithPreview
        preview={
          <span className="break-words line-clamp-2">{contentString}</span>
        }
        content={contentString}
        toolStatus={toolStatus}
        hidePreviewIfExpanded={true}
        wrapContentInPre={true}
        singleColumn={singleColumn}
      />
    </GenericToolPartContent>
  );
}

export function GenericToolPartContentRow({
  index,
  children,
  className,
  singleColumn = false,
}: {
  index: number;
  children: React.ReactNode;
  className?: string;
  singleColumn?: boolean;
}) {
  return (
    <React.Fragment>
      {!singleColumn && (
        <span className="shrink-0">{index === 0 ? "└" : " "}</span>
      )}
      <div className={cn("min-w-0 overflow-hidden", className)}>{children}</div>
    </React.Fragment>
  );
}

export function GenericToolPartClickToExpand({
  label = "Show more",
  onClick,
  isExpanded,
  ariaLabel,
}: {
  label?: string;
  onClick: () => void;
  isExpanded?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="inline text-muted-foreground/70 select-none cursor-pointer bg-transparent border-none p-0 font-inherit"
      onClick={onClick}
      aria-expanded={isExpanded}
      aria-label={ariaLabel ?? label}
    >
      ({label})
    </button>
  );
}

export function GenericToolPartContentResultWithLines({
  lines,
  lineClamp = 3,
  toolStatus,
  singleColumn = false,
  renderAnsi,
}: {
  lines: string[];
  lineClamp?: number;
  toolStatus: AllToolParts["status"];
  singleColumn?: boolean;
  renderAnsi?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isExpandable = lineClamp && lines.length > lineClamp;
  if (lines.length === 0) {
    return (
      <GenericToolPartContent
        toolStatus={toolStatus}
        singleColumn={singleColumn}
      >
        <GenericToolPartContentRow index={0} singleColumn={singleColumn}>
          <span className="text-muted-foreground">(no output)</span>
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }

  const previewLines = lines.slice(0, lineClamp);
  const hasLongLines = previewLines.some(isLongLine);
  if (hasLongLines) {
    const content = lines.join("\n");
    return (
      <GenericToolPartContentResultWithPreview
        preview={
          <>
            <pre className="line-clamp-3 whitespace-pre-wrap">
              {renderAnsi ? (
                <AnsiText text={previewLines.join("\n")} />
              ) : (
                previewLines.join("\n")
              )}
            </pre>
          </>
        }
        content={content}
        toolStatus={toolStatus}
        singleColumn={singleColumn}
        hidePreviewIfExpanded={true}
        wrapContentInPre={!isExpandable}
        renderAnsi={renderAnsi}
      />
    );
  }

  if (!isExpandable) {
    return (
      <GenericToolPartContent
        toolStatus={toolStatus}
        singleColumn={singleColumn}
      >
        {lines.map((line, index) => (
          <GenericToolPartContentRow
            key={index}
            index={index}
            singleColumn={singleColumn}
          >
            {renderAnsi ? <AnsiText text={line} /> : <span>{line}</span>}
          </GenericToolPartContentRow>
        ))}
      </GenericToolPartContent>
    );
  }
  if (!expanded) {
    return (
      <GenericToolPartContent
        toolStatus={toolStatus}
        singleColumn={singleColumn}
      >
        {previewLines.map((line, index) => (
          <GenericToolPartContentRow
            key={index}
            index={index}
            singleColumn={singleColumn}
          >
            <span className="truncate block">
              {renderAnsi ? <AnsiText text={line} /> : line}
            </span>
          </GenericToolPartContentRow>
        ))}
        <GenericToolPartContentRow index={-1} singleColumn={singleColumn}>
          <span>… +{lines.length - lineClamp} more lines</span>{" "}
          <GenericToolPartClickToExpand
            label="Show all"
            onClick={() => setExpanded(true)}
            isExpanded={false}
          />
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }
  const expandedContent = lines.join("\n");
  return (
    <GenericToolPartContent toolStatus={toolStatus} singleColumn={singleColumn}>
      <GenericToolPartContentRow index={0} singleColumn={singleColumn}>
        <span>
          <GenericToolPartClickToExpand
            label="Show less"
            onClick={() => setExpanded(false)}
            isExpanded={true}
          />
        </span>
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow
          index={-1}
          className="max-h-[150px] overflow-auto border border-border rounded-md p-1 mr-2"
          singleColumn={singleColumn}
        >
          {renderAnsi ? (
            <pre>
              <AnsiText text={expandedContent} />
            </pre>
          ) : (
            <pre>{expandedContent}</pre>
          )}
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

export function GenericToolPartContentResultWithPreview({
  preview,
  content,
  toolStatus,
  hidePreviewIfExpanded = false,
  showAllLabel = "Show all",
  showLessLabel = "Show less",
  wrapContentInPre = false,
  singleColumn = false,
  renderAnsi = false,
}: {
  preview: React.ReactNode;
  content: string;
  toolStatus: AllToolParts["status"];
  hidePreviewIfExpanded?: boolean;
  showAllLabel?: string;
  showLessLabel?: string;
  wrapContentInPre?: boolean;
  singleColumn?: boolean;
  renderAnsi?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <GenericToolPartContent toolStatus={toolStatus} singleColumn={singleColumn}>
      <GenericToolPartContentRow index={0} singleColumn={singleColumn}>
        <span>
          {!hidePreviewIfExpanded || !expanded ? preview : null}{" "}
          <GenericToolPartClickToExpand
            label={expanded ? showLessLabel : showAllLabel}
            onClick={() => setExpanded((x) => !x)}
            isExpanded={expanded}
          />
        </span>
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow
          index={-1}
          className="max-h-[150px] overflow-auto border border-border rounded-md p-1 mr-2"
          singleColumn={singleColumn}
        >
          <pre className={wrapContentInPre ? "whitespace-pre-wrap" : ""}>
            {renderAnsi ? <AnsiText text={content} /> : content}
          </pre>
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

/**
 * Component to render ANSI text with colors
 */
export function AnsiText({ text }: { text: string }) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";
  const html = ansiToHtml(text, theme);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
