import React, { useState, useEffect, useRef, useCallback } from "react";
import type {
  AIAgent,
  AIAgentSlashCommand,
  AIModel,
} from "@terragon/agent/types";
import type { Attachment } from "@/lib/attachment-types";
import { getAgentSlashCommands, modelToAgent } from "@terragon/agent/utils";
import { MentionListContent } from "./mention-list";
import { SlashCommandListContent } from "./slash-command-list";
import { Typeahead } from "./typeahead/typeahead";
import { Editor } from "@tiptap/react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "@/components/ui/button";
import { Plus, AtSign, Slash, Paperclip, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { openFileUploadDialog } from "./utils/file-upload";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

export async function getDynamicSlashCommands({
  typeahead,
  agent,
}: {
  typeahead: Typeahead;
  agent: AIAgent;
}): Promise<AIAgentSlashCommand[]> {
  if (agent !== "claudeCode") {
    return [];
  }
  const suggestions = await typeahead.getSuggestions(".claude/commands/");
  const dynamicCmds = suggestions
    .filter((item) => item.type === "blob" && item.name.endsWith(".md"))
    .map((item) => {
      const fileName = item.name.split("/").pop() || "";
      const commandName = fileName.replace(/\.md$/, "");
      return {
        name: commandName,
        description: `Custom command`,
      };
    });
  return dynamicCmds;
}

// Private component for main menu view
function MainMenuView({
  typeahead,
  onSelectFiles,
  onSelectCommands,
  onSelectAttachImages,
}: {
  typeahead?: Typeahead;
  onSelectFiles: () => void;
  onSelectCommands: () => void;
  onSelectAttachImages?: () => void;
}) {
  const hasUploadSection = !!onSelectAttachImages;
  const hasContextSection = !!typeahead;

  return (
    <div className="py-1">
      {hasUploadSection && (
        <div className="xs:hidden">
          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Upload
          </div>
          <div className="px-1">
            <button
              className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm rounded hover:bg-accent hover:text-accent-foreground"
              onClick={onSelectAttachImages}
            >
              <Paperclip className="size-4" />
              <span>Images & PDFs</span>
            </button>
          </div>
        </div>
      )}

      {hasUploadSection && hasContextSection && (
        <div className="my-1 h-px bg-border xs:hidden" />
      )}

      {hasContextSection && (
        <>
          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Reference
          </div>
          <div className="px-1">
            {typeahead && (
              <button
                className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm rounded hover:bg-accent hover:text-accent-foreground"
                onClick={onSelectFiles}
              >
                <AtSign className="size-4" />
                <span>Files and Folders</span>
              </button>
            )}
            <button
              className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm rounded hover:bg-accent hover:text-accent-foreground"
              onClick={onSelectCommands}
            >
              <Slash className="size-4" />
              <span>Slash Commands</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Private component for mention list view
function MentionListView({
  editor,
  typeahead,
  onClose,
  onBack,
  isDrawer = false,
}: {
  editor: Editor | null;
  typeahead: Typeahead;
  onClose: () => void;
  onBack: () => void;
  isDrawer?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<
    { name: string; type?: "blob" | "tree" }[]
  >([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [queryForCurrentResults, setQueryForCurrentResults] = useState<
    string | null
  >(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mentionListRef = useRef<{
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  }>(null);

  // Load suggestions when query changes
  useEffect(() => {
    const loadSuggestions = async () => {
      setIsLoadingFiles(true);
      try {
        const searchQuery = query || "/";
        const results = await typeahead.getSuggestions(searchQuery);
        setItems(results || []);
        setQueryForCurrentResults(query);
      } catch (error) {
        console.error("Failed to get suggestions:", error);
        setItems([]);
      } finally {
        setIsLoadingFiles(false);
      }
    };

    const debounceTimer = setTimeout(loadSuggestions, 100);
    return () => clearTimeout(debounceTimer);
  }, [query, typeahead]);

  // Focus search input on mount
  useEffect(() => {
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  }, []);

  // Reset selected index when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const handleSelectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item && editor) {
        editor.commands.insertContent([
          {
            type: "mention",
            attrs: {
              id: item.name,
              label: item.name,
            },
          },
          {
            type: "text",
            text: " ",
          },
        ]);
        editor.commands.focus();
        onClose();
      }
    },
    [editor, items, onClose],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) {
      const handled = mentionListRef.current?.onKeyDown({
        event: event.nativeEvent,
      });
      if (handled) {
        event.preventDefault();
      }
    } else if (event.key === "Escape") {
      onBack();
      event.preventDefault();
    }
  };
  return (
    <>
      {!isDrawer && (
        <div className="p-3 border-b">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files and folders..."
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      {isDrawer && (
        <div className="px-4 pt-4 pb-2">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files and folders..."
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground px-3 py-2 border rounded-md"
          />
        </div>
      )}
      <div
        className={cn(
          "p-1 space-y-0.5 overflow-y-auto",
          isDrawer ? "max-h-[60vh] px-4" : "max-h-[300px]",
        )}
      >
        <MentionListContent
          ref={mentionListRef}
          items={items}
          selectedIndex={selectedIndex}
          isLoadingFiles={isLoadingFiles}
          queryForCurrentResults={queryForCurrentResults}
          query={query}
          onSelectItem={handleSelectItem}
        />
      </div>
    </>
  );
}

// Private component for slash command view
function SlashCommandView({
  agent,
  editor,
  typeahead,
  onClose,
  onBack,
  isDrawer = false,
}: {
  agent: AIAgent;
  editor: Editor | null;
  typeahead?: Typeahead;
  onClose: () => void;
  onBack: () => void;
  isDrawer?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [commandItems, setCommandItems] = useState<AIAgentSlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoadingDynamic, setIsLoadingDynamic] = useState(false);
  const [dynamicCommands, setDynamicCommands] = useState<AIAgentSlashCommand[]>(
    [],
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const commandListRef = useRef<{
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  }>(null);

  // Fetch dynamic commands on mount
  useEffect(() => {
    if (typeahead) {
      setIsLoadingDynamic(true);
      getDynamicSlashCommands({ typeahead, agent })
        .then((dynamicCmds) => {
          setDynamicCommands(dynamicCmds);
          setIsLoadingDynamic(false);
        })
        .catch((error) => {
          console.error("Failed to fetch dynamic commands:", error);
          setIsLoadingDynamic(false);
        });
    }
  }, [typeahead, agent]);

  // Filter all commands (static + dynamic) based on query
  useEffect(() => {
    const allCommands = [...getAgentSlashCommands(agent), ...dynamicCommands];
    const filtered = query
      ? allCommands.filter(
          (cmd) =>
            cmd.name.toLowerCase().includes(query.toLowerCase()) ||
            cmd.description.toLowerCase().includes(query.toLowerCase()),
        )
      : allCommands;

    // Add loading indicator if still loading
    const finalItems = isLoadingDynamic
      ? [
          ...filtered,
          {
            name: "__loading__",
            description: "Loading custom commands...",
            isLoading: true,
          },
        ]
      : filtered;

    setCommandItems(finalItems);
    setSelectedIndex(0);
  }, [query, dynamicCommands, isLoadingDynamic, agent]);

  // Focus search input on mount
  useEffect(() => {
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  }, []);

  const handleSelectCommand = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  const handleExecuteCommand = useCallback(
    (index: number) => {
      const command = commandItems[index];
      if (command && !command.isLoading && editor) {
        editor.commands.insertContent({
          type: "text",
          text: `/${command.name} `,
        });
        editor.commands.focus();
        onClose();
      }
    },
    [editor, commandItems, onClose],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) {
      const handled = commandListRef.current?.onKeyDown({
        event: event.nativeEvent,
      });
      if (handled) {
        event.preventDefault();
      }
    } else if (event.key === "Escape") {
      onBack();
      event.preventDefault();
    }
  };
  return (
    <>
      {!isDrawer && (
        <div className="p-3 border-b">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands..."
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      {isDrawer && (
        <div className="px-4 pt-4 pb-2">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands..."
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground px-3 py-2 border rounded-md"
          />
        </div>
      )}
      <div
        className={cn(
          "p-1 space-y-0.5 overflow-y-auto",
          isDrawer ? "max-h-[60vh] px-4" : "max-h-[300px]",
        )}
      >
        <SlashCommandListContent
          ref={commandListRef}
          items={commandItems}
          selectedIndex={selectedIndex}
          onSelectItem={handleSelectCommand}
          onExecuteItem={handleExecuteCommand}
        />
      </div>
    </>
  );
}

export function AddContextButton({
  editor,
  typeahead,
  selectedModel,
  className,
  onAttachImages,
}: {
  editor: Editor | null;
  typeahead?: Typeahead;
  selectedModel: AIModel;
  className?: string;
  // Called when user selects image attachments from the menu
  onAttachImages?: (files: Attachment[]) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<"menu" | "files" | "commands">("menu");

  // Reset state when closing either popover or drawer
  useEffect(() => {
    if (!popoverOpen && !drawerOpen) {
      setView("menu");
    }
  }, [popoverOpen, drawerOpen]);

  const closePopover = () => setPopoverOpen(false);
  const closeDrawer = () => setDrawerOpen(false);

  const handleSelectFiles = () => setView("files");
  const handleSelectCommands = () => setView("commands");
  const handleBack = () => setView("menu");

  const handleAttachImages = onAttachImages
    ? () => {
        openFileUploadDialog((files) => {
          onAttachImages(files);
          closePopover();
          closeDrawer();
        });
      }
    : undefined;

  const renderContent = (onClose: () => void, isDrawer = false) => {
    if (view === "menu") {
      return (
        <MainMenuView
          typeahead={typeahead}
          onSelectFiles={handleSelectFiles}
          onSelectCommands={handleSelectCommands}
          onSelectAttachImages={handleAttachImages}
        />
      );
    } else if (view === "files") {
      return (
        <MentionListView
          editor={editor}
          typeahead={typeahead!}
          onClose={onClose}
          onBack={handleBack}
          isDrawer={isDrawer}
        />
      );
    } else {
      return (
        <SlashCommandView
          agent={modelToAgent(selectedModel)}
          editor={editor}
          typeahead={typeahead}
          onClose={onClose}
          onBack={handleBack}
          isDrawer={isDrawer}
        />
      );
    }
  };

  return (
    <>
      {/* Mobile Drawer */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} dismissible modal>
        <DrawerTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className={cn("size-8 flex flex-initial sm:hidden", className)}
            title="Add context"
          >
            <Plus className="size-4" />
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="text-left pb-2 border-b">
            <div className="flex items-center gap-2">
              {view !== "menu" && (
                <button
                  onClick={handleBack}
                  className="p-1 hover:bg-muted rounded"
                >
                  <ChevronLeft className="size-4" />
                </button>
              )}
              <DrawerTitle>
                {view === "menu"
                  ? "Add Context"
                  : view === "files"
                    ? "Files and Folders"
                    : "Slash Commands"}
              </DrawerTitle>
            </div>
          </DrawerHeader>
          <div className={cn(view === "menu" ? "px-0 pb-6" : "pb-0")}>
            {renderContent(closeDrawer, true)}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Desktop Popover */}
      <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className={cn("size-8 hidden sm:flex flex-initial", className)}
            title="Add context"
          >
            <Plus className="size-4" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={cn(
              "z-50 bg-popover text-popover-foreground shadow-md rounded-md border overflow-hidden transition-all duration-200",
              view === "menu" ? "w-[200px]" : "w-[320px]",
            )}
            sideOffset={5}
            align="end"
          >
            {renderContent(closePopover, false)}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
