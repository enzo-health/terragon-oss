"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// The Radix Select wrapper exposed a string-based value API
// (`value?: string`, `onValueChange?(value: string): void`). Base UI's Select
// is generic and its `onValueChange` also passes an `eventDetails` arg and can
// emit `null`. We re-expose the original string-shaped surface — using a
// method-style `onValueChange` so it stays bivariant, matching Radix and
// letting call sites pass narrowed-union callbacks — and adapt internally.
type SelectRootProps = Omit<
  React.ComponentProps<typeof SelectPrimitive.Root<string, false>>,
  "onValueChange" | "value" | "defaultValue"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
};

function Select({ onValueChange, ...props }: SelectRootProps) {
  return (
    <SelectPrimitive.Root
      onValueChange={
        onValueChange
          ? (value) => onValueChange((value ?? "") as string)
          : undefined
      }
      {...(props as React.ComponentProps<typeof SelectPrimitive.Root>)}
    />
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value> & {
  asChild?: boolean;
}) {
  // Radix `asChild` rendered fully custom trigger content in place of the
  // selected item's text. Base UI's Value takes that content as `children`,
  // so we forward it directly and the displayed label stays caller-controlled.
  return (
    <span data-slot="select-value" className="flex items-center gap-2">
      <SelectPrimitive.Value {...props}>{children}</SelectPrimitive.Value>
    </span>
  );
}

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
  variant?: "default" | "ghost";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-variant={variant}
      className={cn(
        "data-[placeholder]:text-mid [&_svg:not([class*='text-'])]:text-mid text-strong focus-visible:border-coral/60 focus-visible:ring-coral/20 aria-invalid:ring-error/20 dark:aria-invalid:ring-error/40 aria-invalid:border-error flex w-fit items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition-[color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "default" &&
          "border-hairline border bg-canvas hover:bg-sunken/60",
        variant === "ghost" && "border-transparent hover:bg-sunken/60",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="size-4 opacity-30" />}
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  align = "start",
  side,
  sideOffset = 4,
  // Accepted for backwards compatibility with the Radix wrapper; Base UI
  // positions via the Positioner so this prop is intentionally ignored.
  position: _position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  align?: React.ComponentProps<typeof SelectPrimitive.Positioner>["align"];
  side?: React.ComponentProps<typeof SelectPrimitive.Positioner>["side"];
  sideOffset?: number;
  position?: "popper" | "item-aligned";
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="z-50 max-h-[var(--available-height)]"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.ScrollUpArrow className="flex cursor-default items-center justify-center py-1">
          <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpArrow>
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "bg-raised text-strong border-hairline data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:scale-95 transition-[opacity,scale] duration-150 relative min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-x-hidden overflow-y-auto rounded-xl border p-1 shadow-card",
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
        <SelectPrimitive.ScrollDownArrow className="flex cursor-default items-center justify-center py-1">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownArrow>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("text-mid px-2 py-1.5 text-xs", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "data-[highlighted]:bg-sunken/60 data-[highlighted]:text-strong text-strong [&_svg:not([class*='text-'])]:text-mid relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        "bg-hairline pointer-events-none -mx-1 my-1 h-px",
        className,
      )}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
