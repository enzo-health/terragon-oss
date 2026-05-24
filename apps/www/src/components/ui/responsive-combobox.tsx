"use client";

import * as React from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useBreakpointCross } from "@/hooks/useBreakpointCross";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

type ComboboxItem = {
  value: string;
  label: string;
  className?: string;
  IconComponent?: React.ComponentType<{ className?: string }>;
};

type ComboboxActionItem = {
  value: string;
  label: string;
  action: () => void;
  icon?: React.ReactNode;
};

const EMPTY_ACTION_ITEMS: ComboboxActionItem[] = [];

export function ResponsiveCombobox<T extends ComboboxItem>({
  icon,
  className,
  contentsClassName,
  items,
  actionItems = EMPTY_ACTION_ITEMS,
  value,
  disabled,
  setValue,
  placeholder,
  emptyText,
  searchPlaceholder,
  onLoadItems,
  isLoading = false,
  loadingText = "Loading...",
  variant = "ghost",
  disableSearch = false,
}: {
  icon?: React.ReactNode;
  className?: string;
  contentsClassName?: string;
  items: T[];
  actionItems?: ComboboxActionItem[];
  value: string | null;
  setValue: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string | ((didSearch: boolean) => React.ReactNode);
  onLoadItems?: () => void;
  isLoading?: boolean;
  loadingText?: string;
  variant?:
    | "ghost"
    | "outline"
    | "default"
    | "secondary"
    | "destructive"
    | "link";
  disableSearch?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();
  const hasLoadedRef = React.useRef(false);
  const onLoadItemsRef = React.useRef(onLoadItems);
  onLoadItemsRef.current = onLoadItems;

  // Load items when opening for the first time
  React.useEffect(() => {
    const loadItems = onLoadItemsRef.current;
    if (open && !hasLoadedRef.current && loadItems) {
      hasLoadedRef.current = true;
      loadItems();
    }
  }, [open]);

  const handleBreakpointCross = React.useCallback(() => {
    setOpen(false);
  }, []);

  // Use debounced media query to prevent rapid component swaps during orientation changes
  const isDesktop = useMediaQuery("(min-width: 768px)", {
    debounceMs: 300,
    initialValue: true, // Default to desktop to prevent flash
  });

  // Force close when crossing the breakpoint to prevent crashes
  useBreakpointCross("(min-width: 768px)", handleBreakpointCross);

  const triggerButton = (
    <Button
      variant={variant}
      size="sm"
      role="combobox"
      aria-expanded={open}
      aria-controls={contentId}
      className={cn(
        "w-fit min-w-0 max-w-[350px] !px-2 justify-between font-normal",
        variant === "ghost" &&
          "text-mid hover:text-strong hover:bg-transparent",
        variant === "outline" && "hover:bg-sunken/60 hover:text-strong",
        "group disabled:bg-canvas disabled:opacity-50",
        className,
      )}
      disabled={disabled}
    >
      <div className="flex items-center gap-2 min-w-0">
        {!!icon && icon}
        <span className="truncate">
          {value
            ? items.find((item) => item.value === value)?.label || value
            : placeholder}
        </span>
      </div>
      <ChevronDown className="group-hover:opacity-100 ml-2 size-4 shrink-0 opacity-30 transition-opacity hidden sm:block" />
    </Button>
  );

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent
          className={cn("min-w-[200px] p-0", contentsClassName)}
          align="start"
          id={contentId}
        >
          <ComboboxContent
            items={items}
            actionItems={actionItems}
            value={value}
            setValue={setValue}
            searchPlaceholder={searchPlaceholder}
            emptyText={emptyText}
            onSelect={() => setOpen(false)}
            isLoading={isLoading}
            loadingText={loadingText}
            disableSearch={disableSearch}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Drawer open={open} onOpenChange={setOpen} dismissible={true} modal={true}>
      <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
      <DrawerContent id={contentId}>
        <DrawerHeader className="text-left">
          <DrawerTitle>{placeholder}</DrawerTitle>
        </DrawerHeader>
        <div className="px-1 pb-4">
          <ComboboxContent
            items={items}
            actionItems={actionItems}
            value={value}
            setValue={setValue}
            searchPlaceholder={searchPlaceholder}
            emptyText={emptyText}
            onSelect={() => setOpen(false)}
            isLoading={isLoading}
            loadingText={loadingText}
            disableSearch={disableSearch}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ComboboxContent<T extends ComboboxItem>({
  items,
  actionItems = EMPTY_ACTION_ITEMS,
  value,
  setValue,
  searchPlaceholder,
  emptyText,
  onSelect,
  isLoading = false,
  loadingText = "Loading...",
  disableSearch = false,
}: {
  items: T[];
  actionItems?: ComboboxActionItem[];
  value: string | null;
  setValue: (value: string) => void;
  searchPlaceholder: string;
  emptyText: string | ((didSearch: boolean) => React.ReactNode);
  onSelect: () => void;
  isLoading?: boolean;
  loadingText?: string;
  disableSearch?: boolean;
}) {
  const [searchValue, setSearchValue] = React.useState("");

  let mainList: React.ReactNode;

  if (isLoading && items.length === 0) {
    mainList = null;
  } else {
    mainList = items.map((item) => {
      return (
        <CommandItem
          key={item.value}
          value={item.value}
          onSelect={() => {
            setValue(item.value === value ? "" : item.value);
            onSelect();
          }}
        >
          {value === item.value || !item.IconComponent ? (
            <Check
              className={cn(
                "mr-2 size-4",
                value === item.value ? "opacity-100" : "opacity-0",
              )}
            />
          ) : (
            item.IconComponent && (
              <item.IconComponent className="mr-2 size-4 opacity-100" />
            )
          )}
          <span className={item.className}>{item.label}</span>
        </CommandItem>
      );
    });

    if (!searchValue && !items.length && actionItems.length && !isLoading) {
      mainList = (
        <div className="py-6 text-center text-sm">
          {typeof emptyText === "function" ? emptyText(false) : emptyText}
        </div>
      );
    }
  }

  return (
    <Command value={value ?? ""} className="max-h-72">
      {!disableSearch && (
        <CommandInput
          placeholder={searchPlaceholder}
          value={searchValue}
          onValueChange={setSearchValue}
        />
      )}
      <CommandList>
        {!isLoading && (
          <CommandEmpty>
            {typeof emptyText === "function" ? emptyText(true) : emptyText}
          </CommandEmpty>
        )}
        <CommandGroup>
          {mainList}
          {isLoading && (
            <div className="flex items-center justify-center text-center text-sm py-6 md:py-4 gap-2">
              <Loader2 className="size-4 animate-spin" />
              {loadingText}
            </div>
          )}
        </CommandGroup>
      </CommandList>
      {actionItems.length > 0 && (
        <div className="border-t border-hairline">
          <CommandGroup>
            {actionItems.map((actionItem) => (
              <CommandItem
                key={actionItem.value}
                value={actionItem.value}
                onSelect={() => {
                  actionItem.action();
                  onSelect();
                }}
              >
                <div className="flex items-center gap-4 w-full">
                  {actionItem.icon}
                  <span>{actionItem.label}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </div>
      )}
    </Command>
  );
}
