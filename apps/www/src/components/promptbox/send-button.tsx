import React, { memo, useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  AudioLines,
  CornerDownLeft,
  Loader2,
  Save,
  ChevronDown,
  Calendar,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsSmallScreen } from "@/hooks/useMediaQuery";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { SheetOrMenu, SheetOrMenuItem } from "@/components/ui/sheet-or-menu";
import { ScheduleTaskDialog } from "./schedule-task-dialog";

function getLabel({
  isSubmitting,
  isSmallScreen,
  isTouchDevice,
}: {
  isSubmitting: boolean;
  isSmallScreen: boolean;
  isTouchDevice: boolean;
}) {
  if (isSubmitting) {
    return "Submitting...";
  }
  return isSmallScreen || isTouchDevice ? "Submit" : "Submit (Enter)";
}

function useTitle({ isSubmitting }: { isSubmitting: boolean }) {
  const isTouchDevice = useTouchDevice();
  const isSmallScreen = useIsSmallScreen();
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  return useMemo(() => {
    if (!isMounted) {
      return getLabel({
        isSubmitting,
        isSmallScreen: false,
        isTouchDevice: false,
      });
    }
    return getLabel({ isSubmitting, isSmallScreen, isTouchDevice });
  }, [isSubmitting, isSmallScreen, isTouchDevice, isMounted]);
}

function SendActionIcon({
  isSubmitting,
  isProcessingAudio,
}: {
  isSubmitting: boolean;
  isProcessingAudio: boolean;
}) {
  if (isProcessingAudio) {
    return (
      <>
        <AudioLines className="size-4" />
        <Loader2 className="size-4 animate-spin" />
      </>
    );
  }
  if (isSubmitting) {
    return <Loader2 className="size-4 animate-spin" />;
  }
  return <CornerDownLeft className="size-4" />;
}

export type TSubmitForm = ({
  saveAsDraft,
  scheduleAt,
}: {
  saveAsDraft: boolean;
  scheduleAt: number | null;
}) => void;

export const SendButton = memo(function SendButton({
  submitForm,
  disabled,
  isProcessingAudio,
  isSubmitting,
  className,
}: {
  submitForm: TSubmitForm;
  disabled: boolean;
  isProcessingAudio: boolean;
  isSubmitting: boolean;
  className?: string;
}) {
  const title = useTitle({ isSubmitting });
  return (
    <Button
      onClick={(event) => {
        event.preventDefault();
        submitForm({ saveAsDraft: false, scheduleAt: null });
      }}
      title={title}
      disabled={disabled || isSubmitting || isProcessingAudio}
      className={cn(
        "size-auto h-8 px-2 transition-all duration-200",
        isSubmitting && "animate-pulse-subtle",
        className,
      )}
      size="icon"
    >
      <SendActionIcon
        isSubmitting={isSubmitting}
        isProcessingAudio={isProcessingAudio}
      />
    </Button>
  );
});

export const SendComboButton = memo(function SendComboButton({
  submitForm,
  disabled,
  isProcessingAudio,
  isSubmitting,
  className,
  supportSaveAsDraft,
  supportSchedule,
}: {
  submitForm: TSubmitForm;
  disabled: boolean;
  isProcessingAudio: boolean;
  isSubmitting: boolean;
  className?: string;
  supportSaveAsDraft?: boolean;
  supportSchedule?: boolean;
}) {
  const title = useTitle({ isSubmitting });
  const isSmallScreen = useIsSmallScreen();
  const isDisabled = disabled || isSubmitting || isProcessingAudio;
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);

  const getItems = () => {
    const items: SheetOrMenuItem[] = [];
    if (isSmallScreen) {
      items.push({
        type: "button",
        label: "Submit",
        icon: CornerDownLeft,
        onSelect: () => submitForm({ saveAsDraft: false, scheduleAt: null }),
      });
    }
    if (supportSaveAsDraft) {
      items.push({
        type: "button",
        label: "Save as draft",
        icon: Save,
        onSelect: () => submitForm({ saveAsDraft: true, scheduleAt: null }),
      });
    }
    if (supportSchedule) {
      items.push({
        type: "button",
        label: "Schedule task",
        icon: Calendar,
        onSelect: () => {
          setShowScheduleDialog(true);
        },
      });
    }
    return items;
  };

  return (
    <>
      <div
        className={cn(
          "relative inline-flex",
          isSubmitting && "animate-pulse-subtle",
        )}
      >
        <Button
          onClick={(event) => {
            event.preventDefault();
            submitForm({ saveAsDraft: false, scheduleAt: null });
          }}
          title={title}
          disabled={isDisabled}
          className={cn(
            "h-8 px-2 pr-6 transition-all duration-200 rounded-r-none group",
            isSubmitting && "opacity-90",
            className,
          )}
          size="sm"
        >
          <SendActionIcon
            isSubmitting={isSubmitting}
            isProcessingAudio={isProcessingAudio}
          />
        </Button>
        <SheetOrMenu
          trigger={
            <Button
              disabled={isDisabled}
              className={cn(
                "h-8 w-8 px-0 rounded-l-none border-l border-l-background/20 hover:border-l-background/30 transition-all",
                className,
              )}
              size="sm"
            >
              <ChevronDown className={cn("size-3 transition-transform")} />
            </Button>
          }
          title="Submit Options"
          collapseAsDrawer
          getItems={getItems}
        />
      </div>
      <ScheduleTaskDialog
        open={showScheduleDialog}
        onOpenChange={setShowScheduleDialog}
        onSchedule={(timestamp) => {
          submitForm({ saveAsDraft: false, scheduleAt: timestamp });
        }}
      />
    </>
  );
});
