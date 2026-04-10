"use client";

import * as React from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useBreakpointCross } from "@/hooks/useBreakpointCross";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "./button";
import { assertNever } from "@leo/shared/utils";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useCallback } from "react";
import { Drawer, DrawerContent, DrawerTrigger } from "./drawer";
import { Check, Circle, LucideIcon } from "lucide-react";

export type SheetOrMenuItem =
  | {
      type: "link";
      target?: "_blank" | "_self" | "_parent" | "_top";
      label: string;
      href: string;
      icon?: LucideIcon;
    }
  | {
      type: "button";
      label: string;
      className?: string;
      destructive?: boolean;
      isDisabled?: boolean;
      onSelect: () => void | Promise<void>;
      icon?: LucideIcon;
      rightIcon?: LucideIcon;
    }
  | {
      type: "separator";
    }
  | {
      type: "label";
      label: string;
    }
  | {
      type: "checkbox";
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void | Promise<void>;
      isDisabled?: boolean;
      icon?: LucideIcon;
    };

export type SheetOrMenuProps = {
  forceDropdownMenu?: boolean;
  collapseAsDrawer?: boolean;
  disabled?: boolean;
  trigger: React.ReactNode;
  title: string;
  getItems: () => SheetOrMenuItem[];
  onOpenChange?: (open: boolean) => void;
};

function getMenuItemKey(item: SheetOrMenuItem, index: number): string {
  switch (item.type) {
    case "link":
      return `link:${item.href}:${item.label}:${index}`;
    case "button":
      return `button:${item.label}:${index}`;
    case "checkbox":
      return `checkbox:${item.label}:${index}`;
    case "label":
      return `label:${item.label}:${index}`;
    case "separator":
      return `separator:${index}`;
    default:
      return assertNever(item);
  }
}

export function SheetOrMenu({
  forceDropdownMenu,
  collapseAsDrawer,
  disabled,
  trigger,
  title,
  onOpenChange,
  getItems,
}: SheetOrMenuProps) {
  const [open, setOpenInner] = React.useState(false);
  const setOpen = useCallback(
    (open: boolean) => {
      setOpenInner(open);
      onOpenChange?.(open);
    },
    [onOpenChange],
  );
  // Use debounced media query to prevent rapid component swaps during orientation changes
  const isSmallScreen = useMediaQuery("(max-width: 40rem)", {
    debounceMs: 300,
    initialValue: false, // Default to desktop to prevent flash
  });

  // Force close when crossing the breakpoint to prevent crashes
  useBreakpointCross("(max-width: 40rem)", () => {
    if (open && !forceDropdownMenu) {
      setOpen(false);
    }
  });

  if (!isSmallScreen || forceDropdownMenu) {
    return (
      <DropdownMenu
        open={open}
        onOpenChange={(open) => {
          if (!disabled) {
            setOpen(open);
          }
        }}
      >
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          <MenuContents
            getItems={getItems}
            isSmallScreen={isSmallScreen}
            forceDropdownMenu={!!forceDropdownMenu}
            setClose={() => setOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (collapseAsDrawer) {
    return (
      <Drawer
        open={open}
        onOpenChange={(open) => {
          if (!disabled) {
            setOpen(open);
          }
        }}
        dismissible={true}
        modal={true}
      >
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent
          className="pb-4"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          <MenuContents
            getItems={getItems}
            isSmallScreen={isSmallScreen}
            forceDropdownMenu={false}
            setClose={() => setOpen(false)}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(open) => {
        if (!disabled) {
          setOpen(open);
        }
      }}
    >
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="top" className="pt-16 px-4 pb-4">
        <VisuallyHidden>
          <SheetTitle>{title}</SheetTitle>
        </VisuallyHidden>
        <MenuContents
          getItems={getItems}
          isSmallScreen={isSmallScreen}
          forceDropdownMenu={false}
          setClose={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

function MenuContents({
  getItems,
  isSmallScreen,
  forceDropdownMenu,
  setClose,
}: {
  getItems: () => SheetOrMenuItem[];
  isSmallScreen: boolean;
  forceDropdownMenu: boolean;
  setClose: () => void;
}) {
  const items = getItems();
  if (!isSmallScreen || forceDropdownMenu) {
    // Desktop dropdown menu
    const insetOrUndef =
      items.some((item) => item.type === "checkbox") || undefined;
    return (
      <>
        {items.map((item, index) => {
          const itemKey = getMenuItemKey(item, index);
          switch (item.type) {
            case "checkbox":
              return (
                <DropdownMenuCheckboxItem
                  key={itemKey}
                  checked={item.checked}
                  onCheckedChange={(checked) => {
                    item.onCheckedChange(checked);
                    setClose();
                  }}
                  disabled={item.isDisabled}
                >
                  {item.icon && <item.icon className="h-4 w-4 mr-2" />}
                  {item.label}
                </DropdownMenuCheckboxItem>
              );
            case "separator":
              return <DropdownMenuSeparator key={itemKey} />;
            case "label":
              return (
                <DropdownMenuLabel
                  key={itemKey}
                  className="text-xs text-muted-foreground/50 uppercase py-0.5"
                >
                  {item.label}
                </DropdownMenuLabel>
              );
            case "button":
              return (
                <DropdownMenuItem
                  inset={insetOrUndef}
                  key={itemKey}
                  disabled={item.isDisabled}
                  variant={item.destructive ? "destructive" : undefined}
                  className={item.className}
                  onSelect={() => {
                    item.onSelect();
                    setClose();
                  }}
                >
                  {item.icon && <item.icon className="h-4 w-4 mr-2" />}
                  <span className="flex-1">{item.label}</span>
                  {item.rightIcon && (
                    <item.rightIcon className="h-4 w-4 ml-2" />
                  )}
                </DropdownMenuItem>
              );
            case "link":
              return (
                <DropdownMenuItem key={itemKey} asChild>
                  <Link href={item.href} target={item.target}>
                    {item.icon && <item.icon className="h-4 w-4 mr-2" />}
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              );
            default:
              assertNever(item);
          }
        })}
      </>
    );
  }
  // Mobile sheet
  return (
    <div className="flex flex-col gap-2 py-2">
      {items.map((item, index) => {
        const itemKey = getMenuItemKey(item, index);
        switch (item.type) {
          case "button": {
            return (
              <Button
                key={itemKey}
                disabled={item.isDisabled}
                onClick={() => {
                  item.onSelect();
                  setClose();
                }}
                variant="ghost"
                className={cn(
                  "w-full text-left flex items-center justify-start py-4 px-4",
                  {
                    "!text-destructive": item.destructive,
                  },
                  item.className,
                )}
              >
                {item.icon && <item.icon className="h-5 w-5 mr-3" />}
                <span className="flex-1">{item.label}</span>
                {item.rightIcon && <item.rightIcon className="h-5 w-5 ml-3" />}
              </Button>
            );
          }
          case "checkbox": {
            return (
              <Button
                key={itemKey}
                disabled={item.isDisabled}
                onClick={() => {
                  item.onCheckedChange(!item.checked);
                  setClose();
                }}
                variant="ghost"
                className="w-full text-left justify-start py-4 px-4"
              >
                {item.icon && <item.icon className="h-5 w-5 mr-3" />}
                {item.checked ? (
                  <Check className="size-4" />
                ) : (
                  <Circle className="size-4 opacity-0" />
                )}
                {item.label}
              </Button>
            );
          }
          case "link":
            return (
              <Button key={itemKey} variant="ghost" asChild>
                <Link
                  href={item.href}
                  target={item.target}
                  className="w-full text-left flex items-center justify-start py-4 px-4"
                >
                  {item.icon && <item.icon className="h-5 w-5 mr-3" />}
                  {item.label}
                </Link>
              </Button>
            );
          case "separator":
            return (
              <DropdownMenuSeparator key={itemKey} className="bg-border/50" />
            );
          case "label":
            return (
              <DropdownMenuLabel
                key={itemKey}
                className="text-xs text-muted-foreground/50 uppercase py-0.5"
              >
                {item.label}
              </DropdownMenuLabel>
            );
          default:
            assertNever(item);
        }
      })}
    </div>
  );
}
