"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CloudOff, CloudUpload } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckpointToggleProps {
  disabled?: boolean;
  value: boolean; // true = checkpointing disabled
  onChange: (disabled: boolean) => void;
  showDialog?: boolean;
}

export function CheckpointToggle({
  disabled,
  value,
  onChange,
  showDialog = true,
}: CheckpointToggleProps) {
  const disableGitCheckpointing = value;
  const setDisableGitCheckpointing = onChange;
  const [showDisableConfirmDialog, setShowDisableConfirmDialog] =
    React.useState(false);

  const checkpointingEnabled = !disableGitCheckpointing;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        type="button"
        className={cn(
          checkpointingEnabled
            ? "text-muted-foreground hover:text-muted-foreground"
            : "text-destructive opacity-70 hover:text-destructive",
          "",
        )}
        aria-pressed={checkpointingEnabled}
        aria-label="Toggle checkpointing"
        title="Toggle checkpointing"
        disabled={disabled}
        onClick={async () => {
          if (disabled) return;
          if (!showDialog) {
            // Directly toggle without confirmation: when enabled -> disable, when disabled -> enable
            // disableGitCheckpointing should mirror the inverse of checkpointingEnabled
            setDisableGitCheckpointing(checkpointingEnabled);
            return;
          }
          if (checkpointingEnabled) {
            // Disabling: confirm via dialog
            setShowDisableConfirmDialog(true);
          } else {
            // Enabling: no confirmation
            setDisableGitCheckpointing(false);
          }
        }}
      >
        {checkpointingEnabled ? (
          <CloudUpload className="h-4 w-4" />
        ) : (
          <CloudOff className="h-4 w-4" />
        )}
      </Button>

      <Dialog
        open={showDisableConfirmDialog}
        onOpenChange={setShowDisableConfirmDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable Git checkpointing</DialogTitle>
            <DialogDescription>
              <br />
              Are you sure you want to disable{" "}
              <a
                href="https://docs.terragonlabs.com/docs/configuration/git-checkpointing"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Leo's automatic git checkpointing
              </a>
              ?<br />
              <br />
              When disabled you are responsible for prompting the agent to
              commit and publish completed work.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDisableConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                setDisableGitCheckpointing(true);
                setShowDisableConfirmDialog(false);
              }}
            >
              Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
