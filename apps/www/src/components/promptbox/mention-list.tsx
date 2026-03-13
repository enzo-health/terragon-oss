import React, {
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";
import { SuggestionProps } from "@tiptap/suggestion";
import { FileIcon, FolderIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function formatFilePath(path: string, maxChars: number = 30) {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];

  if (parts.length <= 1) {
    return { filename, directory: "" };
  }

  // Get all directory parts (excluding filename)
  const dirParts = parts.slice(0, -1);
  const fullDirectory = dirParts.join("/");

  // If directory is within limit, show it as is
  if (fullDirectory.length <= maxChars) {
    return { filename, directory: fullDirectory };
  }

  // Otherwise, truncate from the beginning and add ellipsis
  const ellipsis = "...";
  const availableChars = maxChars - ellipsis.length;

  // Edge case: if available chars is too small, just return ellipsis
  if (availableChars <= 0) {
    return { filename, directory: ellipsis };
  }

  // Start from the end and build up the directory path
  let result = [];
  let currentLength = 0;

  for (let i = dirParts.length - 1; i >= 0; i--) {
    const part = dirParts[i];
    if (!part) continue; // TypeScript safety check

    const partLength = part.length + (result.length > 0 ? 1 : 0); // +1 for "/"

    if (currentLength + partLength <= availableChars) {
      result.unshift(part);
      currentLength += partLength;
    } else {
      // Can't fit any more parts
      break;
    }
  }

  // If we couldn't fit all parts, add ellipsis
  const truncatedDir = result.join("/");
  if (result.length < dirParts.length) {
    if (truncatedDir.length === 0) {
      // No parts could fit
      return { filename, directory: ellipsis };
    }
    return { filename, directory: ellipsis + "/" + truncatedDir };
  }

  return { filename, directory: truncatedDir };
}

interface MentionListContentProps {
  items: { name: string; type?: "blob" | "tree" }[];
  selectedIndex: number;
  isLoadingFiles?: boolean;
  queryForCurrentResults?: string | null;
  query: string;
  onSelectItem: (index: number) => void;
  onExecuteItem?: (index: number) => void;
}

export const MentionListContent = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  MentionListContentProps
>((props, ref) => {
  const {
    items,
    selectedIndex,
    isLoadingFiles,
    queryForCurrentResults,
    query,
    onSelectItem,
    onExecuteItem,
  } = props;

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const upHandler = () => {
    const newIndex = (selectedIndex + items.length - 1) % items.length;
    onSelectItem(newIndex);
  };

  const downHandler = () => {
    const newIndex = (selectedIndex + 1) % items.length;
    onSelectItem(newIndex);
  };

  const enterHandler = () => {
    if (onExecuteItem) {
      onExecuteItem(selectedIndex);
    } else {
      onSelectItem(selectedIndex);
    }
  };

  // Scroll the selected item into view when selectedIndex changes
  useEffect(() => {
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        upHandler();
        return true;
      }

      if (event.key === "ArrowDown") {
        downHandler();
        return true;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        enterHandler();
        return true;
      }

      return false;
    },
  }));

  return (
    <>
      {isLoadingFiles ? (
        <div className="text-sm text-muted-foreground px-2 py-1.5 flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading repository files...
        </div>
      ) : items.length ? (
        items.map((item, index) => (
          <button
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            className={cn(
              "flex items-center gap-2 w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent hover:text-accent-foreground",
              index === selectedIndex && "bg-accent text-accent-foreground",
            )}
            key={item.name}
            onClick={() =>
              onExecuteItem ? onExecuteItem(index) : onSelectItem(index)
            }
          >
            {item.type === "tree" ? (
              <FolderIcon className="size-4 flex-shrink-0" />
            ) : (
              <FileIcon className="size-4 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0 flex flex-col">
              {(() => {
                const { filename, directory } = formatFilePath(item.name);
                if (!filename) {
                  return (
                    <span className="font-medium truncate">{directory}</span>
                  );
                }
                return (
                  <>
                    <span className="font-medium truncate">{filename}</span>
                    {directory && (
                      <span className="text-xs text-muted-foreground truncate">
                        {directory}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          </button>
        ))
      ) : (
        <div className="text-sm text-muted-foreground px-2 py-1.5">
          {queryForCurrentResults !== query
            ? "Loading files..."
            : query
              ? "No files found"
              : "Loading files..."}
        </div>
      )}
    </>
  );
});

MentionListContent.displayName = "MentionListContent";

export const MentionList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  SuggestionProps<{ name: string; type?: "blob" | "tree" }> & {
    isLoadingFiles?: boolean;
    queryForCurrentResults?: string | null;
  }
>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const contentRef = useRef<{
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  }>(null);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command({ id: item.name, label: item.name });
    }
  };

  const handleSelectIndex = (index: number) => {
    setSelectedIndex(index);
  };

  useEffect(() => setSelectedIndex(0), []);

  useImperativeHandle(ref, () => ({
    onKeyDown: (eventProps: { event: KeyboardEvent }) => {
      return contentRef.current?.onKeyDown(eventProps) || false;
    },
  }));
  return (
    <div className="dropdown-menu z-50 bg-popover text-popover-foreground shadow-md rounded-md border p-1 space-y-0.5 min-w-[300px] max-h-[300px] overflow-y-auto">
      <MentionListContent
        ref={contentRef}
        items={props.items}
        selectedIndex={selectedIndex}
        isLoadingFiles={props.isLoadingFiles}
        queryForCurrentResults={props.queryForCurrentResults}
        query={props.query}
        onSelectItem={handleSelectIndex}
        onExecuteItem={selectItem}
      />
    </div>
  );
});

MentionList.displayName = "MentionList";
