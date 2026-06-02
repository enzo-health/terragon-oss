"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { asChildToRender } from "./base-ui-as-child";

// AGENT-PROTECTION INVARIANT: Base UI traps the Escape key inside the topmost
// open dialog by default and does NOT propagate it to global keydown listeners.
// Our app has a global Escape handler that stops the running agent, so this
// default is load-bearing — it keeps Escape from killing the agent while a
// dialog is open. Do NOT call `eventDetails.allowPropagation()` for the
// "escape-key" reason in any Dialog `onOpenChange` handler, and do not add a
// global keydown listener inside dialogs that re-dispatches Escape.
function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger> & {
  asChild?: boolean;
}) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      {...asChildToRender({ asChild, ...props })}
    />
  );
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  asChild,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close> & {
  asChild?: boolean;
}) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      {...asChildToRender({ asChild, ...props })}
    />
  );
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-200 fixed inset-0 z-50 bg-canvas/40 backdrop-blur-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  hideCloseButton = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & {
  hideCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "bg-raised text-strong data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:scale-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-6 rounded-2xl shadow-card transition-[opacity,scale,transform] duration-200 sm:max-w-lg overflow-hidden p-8",
          className,
        )}
        {...props}
      >
        {children}
        {!hideCloseButton && (
          <DialogPrimitive.Close className="text-mid hover:text-strong focus-visible:ring-coral/50 absolute top-5 right-5 rounded-full p-1 opacity-40 transition-[opacity,background-color,box-shadow,transform] duration-150 active:scale-[0.96] hover:opacity-100 hover:bg-sunken/60 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none before:absolute before:-inset-3 before:content-[''] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-3 sm:flex-row sm:justify-end mt-2",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-xl leading-tight font-semibold tracking-[-0.015em]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-mid text-[15px] leading-relaxed", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
