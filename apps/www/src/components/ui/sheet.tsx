"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { asChildToRender } from "./base-ui-as-child";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root {...props} />;
}

function SheetTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger> & {
  asChild?: boolean;
}) {
  return (
    <SheetPrimitive.Trigger
      data-slot="sheet-trigger"
      {...asChildToRender({ asChild, ...props })}
    />
  );
}

function SheetClose({
  asChild,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close> & {
  asChild?: boolean;
}) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      {...asChildToRender({ asChild, ...props })}
    />
  );
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity fixed inset-0 z-50 bg-canvas/40 backdrop-blur-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Popup> & {
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "bg-raised text-strong fixed z-50 flex flex-col gap-4 shadow-card transition ease-in-out data-[ending-style]:duration-300 data-[starting-style]:duration-500",
          side === "right" &&
            "data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full inset-y-0 right-0 h-full w-3/4 border-l border-hairline sm:max-w-sm",
          side === "left" &&
            "data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full inset-y-0 left-0 h-full w-3/4 border-r border-hairline sm:max-w-sm",
          side === "top" &&
            "data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full inset-x-0 top-0 h-auto border-b border-hairline",
          side === "bottom" &&
            "data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full inset-x-0 bottom-0 h-auto border-t border-hairline",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="text-mid hover:text-strong focus-visible:ring-coral/50 absolute top-4 right-4 rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "text-strong font-semibold text-xl leading-tight tracking-[-0.015em]",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-mid text-[15px] leading-relaxed", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
