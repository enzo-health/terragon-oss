"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ArchiveIcon } from "@/components/icons/archive";
import { CheckpointToggle } from "./checkpoint-toggle";
import { SkipSetupToggle } from "./skip-setup-toggle";
import { BranchToggle } from "./branch-toggle";
import { toast } from "sonner";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { Repeat2 } from "lucide-react";
import {
  disableGitCheckpointingCookieAtom,
  createNewBranchCookieAtom,
  skipSetupCookieAtom,
} from "@/atoms/user-cookies";
import { useAtom } from "jotai";

interface PromptBoxToolBeltProps {
  /** Whether to show the skip archive button */
  showSkipArchive?: boolean;
  /** Value for skip archive (true = archiving is disabled) */
  skipArchiveValue?: boolean;
  /** Handler for skip archive toggle */
  onSkipArchiveChange?: (value: boolean) => void;

  /** Whether to show the skip setup button */
  showSkipSetup?: boolean;
  /** Value for skip setup (true = setup is disabled) */
  skipSetupValue?: boolean;
  /** Handler for skip setup toggle */
  onSkipSetupChange?: (value: boolean) => void;
  /** Whether to disable skip setup button */
  skipSetupDisabled?: boolean;
  /** Whether to disable toast for skip setup */
  skipSetupDisableToast?: boolean;

  /** Whether to show the checkpoint toggle button */
  showCheckpoint?: boolean;
  /** Value for checkpoint (true = checkpointing is disabled) */
  checkpointValue?: boolean;
  /** Handler for checkpoint toggle */
  onCheckpointChange?: (value: boolean) => void;
  /** Whether to disable checkpoint button */
  checkpointDisabled?: boolean;
  /** Whether to show confirmation dialog when disabling checkpointing */
  checkpointShowDialog?: boolean;

  /** Whether to show the branch toggle button */
  showCreateNewBranchOption?: boolean;
  /** Value for create new branch option (true = create new branch) */
  createNewBranchValue?: boolean;
  /** Handler for branch toggle */
  onCreateNewBranchChange?: (value: boolean) => void;
  /** Whether to disable create new branch button */
  createNewBranchDisabled?: boolean;

  /** Whether to show SDLC loop opt-in toggle */
  showSdlcLoopOptIn?: boolean;
  /** Value for SDLC loop opt-in toggle */
  sdlcLoopOptInValue?: boolean;
  /** Handler for SDLC loop opt-in toggle */
  onSdlcLoopOptInChange?: (value: boolean) => void;
  /** Whether to disable SDLC loop opt-in toggle */
  sdlcLoopOptInDisabled?: boolean;
}

export function PromptBoxToolBelt({
  showSkipArchive = false,
  skipArchiveValue = false,
  onSkipArchiveChange,
  showSkipSetup = false,
  skipSetupValue = false,
  onSkipSetupChange,
  skipSetupDisabled = false,
  skipSetupDisableToast = false,
  showCheckpoint = false,
  checkpointValue = false,
  onCheckpointChange,
  checkpointDisabled = false,
  checkpointShowDialog = true,
  showCreateNewBranchOption = false,
  createNewBranchValue = true,
  onCreateNewBranchChange,
  createNewBranchDisabled = false,
  showSdlcLoopOptIn = false,
  sdlcLoopOptInValue = false,
  onSdlcLoopOptInChange,
  sdlcLoopOptInDisabled = false,
}: PromptBoxToolBeltProps) {
  const isBranchToggleEnabled = useFeatureFlag("branchCreationToggle");

  if (
    !showSkipArchive &&
    !showSkipSetup &&
    !showCheckpoint &&
    !showSdlcLoopOptIn &&
    (!showCreateNewBranchOption || !isBranchToggleEnabled)
  ) {
    return null;
  }

  return (
    <div className="flex items-center gap-0">
      {showSkipArchive && (
        <Button
          variant="ghost"
          size="icon"
          type="button"
          title="Skip archiving the current task"
          onClick={() => {
            const newValue = !skipArchiveValue;
            onSkipArchiveChange?.(newValue);
            toast.success(
              newValue ? "Skip archiving enabled" : "Skip archiving disabled",
            );
          }}
        >
          <ArchiveIcon className="h-4 w-4" isOff={skipArchiveValue} />
        </Button>
      )}
      {showSkipSetup && (
        <SkipSetupToggle
          disabled={skipSetupDisabled}
          disableToast={skipSetupDisableToast}
          value={skipSetupValue}
          onChange={onSkipSetupChange!}
        />
      )}
      {showCreateNewBranchOption && isBranchToggleEnabled && (
        <BranchToggle
          disabled={createNewBranchDisabled}
          checkpointValue={checkpointValue}
          value={createNewBranchValue}
          onChange={onCreateNewBranchChange!}
        />
      )}
      {showCheckpoint && (
        <CheckpointToggle
          disabled={checkpointDisabled}
          value={checkpointValue}
          onChange={onCheckpointChange!}
          showDialog={checkpointShowDialog}
        />
      )}
      {showSdlcLoopOptIn && (
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={
            sdlcLoopOptInValue
              ? "text-muted-foreground hover:text-muted-foreground"
              : "opacity-50 hover:opacity-50"
          }
          aria-pressed={sdlcLoopOptInValue}
          aria-label={
            sdlcLoopOptInValue
              ? "Run task in SDLC loop"
              : "Run task without SDLC loop"
          }
          title={
            sdlcLoopOptInValue
              ? "Run task in SDLC loop"
              : "Run task without SDLC loop"
          }
          disabled={sdlcLoopOptInDisabled}
          onClick={() => {
            if (sdlcLoopOptInDisabled) {
              return;
            }
            const nextValue = !sdlcLoopOptInValue;
            onSdlcLoopOptInChange?.(nextValue);
            toast.success(
              nextValue
                ? "SDLC loop will run for this task"
                : "SDLC loop is off for this task",
            );
          }}
        >
          <Repeat2
            className={`h-4 w-4 ${sdlcLoopOptInValue ? "" : "opacity-50"}`}
          />
        </Button>
      )}
    </div>
  );
}

export function usePromptBoxToolBeltOptions({
  branchName,
  shouldUseCookieValues,
  initialSkipSetup,
  initialDisableGitCheckpointing,
  initialCreateNewBranch,
}: {
  branchName: string | null;
  shouldUseCookieValues?: boolean;
  initialSkipSetup?: boolean;
  initialDisableGitCheckpointing?: boolean;
  initialCreateNewBranch?: boolean;
}) {
  const [skipArchiving, setSkipArchiving] = useState<boolean>(false);
  const [skipSetupCookie, setSkipSetupCookie] = useAtom(skipSetupCookieAtom);
  const [disableGitCheckpointingCookie, setDisableGitCheckpointingCookie] =
    useAtom(disableGitCheckpointingCookieAtom);
  const [createNewBranchCookie, setCreateNewBranchCookie] = useAtom(
    createNewBranchCookieAtom,
  );

  const [skipSetupLocal, setSkipSetupLocal] = useState<boolean>(
    shouldUseCookieValues ? skipSetupCookie : (initialSkipSetup ?? false),
  );
  const [disableGitCheckpointingLocal, setDisableGitCheckpointingLocal] =
    useState<boolean>(
      shouldUseCookieValues
        ? disableGitCheckpointingCookie
        : (initialDisableGitCheckpointing ?? false),
    );
  const [createNewBranchState, setCreateNewBranchState] = useState<boolean>(
    shouldUseCookieValues
      ? createNewBranchCookie
      : (initialCreateNewBranch ?? true),
  );

  const createNewBranch = useMemo(() => {
    if (disableGitCheckpointingLocal) {
      return false;
    }
    return createNewBranchState;
  }, [disableGitCheckpointingLocal, createNewBranchState]);

  const setSkipSetup = useCallback(
    (value: boolean) => {
      setSkipSetupLocal(value);
      if (shouldUseCookieValues) {
        setSkipSetupCookie(value);
      }
    },
    [shouldUseCookieValues, setSkipSetupCookie, setSkipSetupLocal],
  );

  const setDisableGitCheckpointing = useCallback(
    (value: boolean) => {
      setDisableGitCheckpointingLocal(value);
      if (shouldUseCookieValues) {
        setDisableGitCheckpointingCookie(value);
      }
    },
    [
      shouldUseCookieValues,
      setDisableGitCheckpointingCookie,
      setDisableGitCheckpointingLocal,
    ],
  );

  const setCreateNewBranch = useCallback(
    (value: boolean) => {
      setCreateNewBranchState(value);
      if (shouldUseCookieValues) {
        setCreateNewBranchCookie(value);
      }
    },
    [shouldUseCookieValues, setCreateNewBranchCookie, setCreateNewBranchState],
  );

  const branchNameRef = useRef(branchName);
  useEffect(() => {
    if (branchName && branchName !== branchNameRef.current) {
      branchNameRef.current = branchName;
      setCreateNewBranch(true);
    }
  }, [branchName, setCreateNewBranch]);

  return {
    skipSetup: skipSetupLocal,
    disableGitCheckpointing: disableGitCheckpointingLocal,
    createNewBranch,
    skipArchiving,
    setSkipSetup,
    setSkipArchiving,
    setDisableGitCheckpointing,
    setCreateNewBranch,
  };
}
