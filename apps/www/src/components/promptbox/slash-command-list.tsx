import React, {
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";
import { SuggestionProps } from "@tiptap/suggestion";
import { cn } from "@/lib/utils";
import type { AIModel, AIAgentSlashCommand } from "@leo/agent/types";

interface SlashCommandListContentProps {
  items: AIAgentSlashCommand[];
  selectedIndex: number;
  onSelectItem: (index: number) => void;
  onExecuteItem?: (index: number) => void;
  /** Currently selected AI model (used to customize empty-state messaging) */
  selectedModel?: AIModel;
}

export const SlashCommandListContent = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  SlashCommandListContentProps
>((props, ref) => {
  const { items, selectedIndex, onSelectItem, onExecuteItem } = props;

  const upHandler = () => {
    const newIndex = (selectedIndex + items.length - 1) % items.length;
    onSelectItem(newIndex);
  };

  const downHandler = () => {
    const newIndex = (selectedIndex + 1) % items.length;
    onSelectItem(newIndex);
  };

  const enterHandler = () => {
    const selectedItem = items[selectedIndex];
    if (selectedItem) {
      if (onExecuteItem) {
        onExecuteItem(selectedIndex);
      } else {
        onSelectItem(selectedIndex);
      }
    }
  };

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
      {items.length ? (
        <div className="overflow-hidden text-foreground">
          {items.map((item, index) => (
            <div
              key={item.name}
              onClick={() =>
                onExecuteItem ? onExecuteItem(index) : onSelectItem(index)
              }
              onMouseEnter={() => onSelectItem(index)}
              className={cn(
                "relative flex cursor-default select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
                "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                index === selectedIndex && "bg-accent text-accent-foreground",
              )}
            >
              <div className="flex flex-col gap-0.5">
                {item.isLoading ? (
                  <div className="flex items-center gap-2 py-0.5">
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
                    <span className="text-xs text-muted-foreground italic">
                      Loading repository commands...
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="font-medium">/{item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.description}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-2 px-2 text-center text-sm text-muted-foreground">
          No matching commands
        </div>
      )}
    </>
  );
});

SlashCommandListContent.displayName = "SlashCommandListContent";

export const SlashCommandList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  SuggestionProps<AIAgentSlashCommand> & { selectedModel?: AIModel }
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when items change
  useEffect(() => setSelectedIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (eventProps: { event: KeyboardEvent }) => {
      return contentRef.current?.onKeyDown(eventProps) || false;
    },
  }));

  return (
    <div className="z-50 min-w-[250px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
      <div className="max-h-[300px] overflow-y-auto p-1">
        <SlashCommandListContent
          ref={contentRef}
          items={props.items}
          selectedIndex={selectedIndex}
          onSelectItem={handleSelectIndex}
          onExecuteItem={selectItem}
          selectedModel={props.selectedModel}
        />
      </div>
    </div>
  );
});

SlashCommandList.displayName = "SlashCommandList";
