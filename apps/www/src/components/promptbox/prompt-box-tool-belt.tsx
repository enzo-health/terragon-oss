"use client";

import { useAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  createNewBranchCookieAtom,
  disableGitCheckpointingCookieAtom,
  skipSetupCookieAtom,
} from "@/atoms/user-cookies";
import { ArchiveIcon } from "@/components/icons/archive";
import { Button } from "@/components/ui/button";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { BranchToggle } from "./branch-toggle";
import { CheckpointToggle } from "./checkpoint-toggle";
import { SkipSetupToggle } from "./skip-setup-toggle";

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
}: PromptBoxToolBeltProps) {
  const isBranchToggleEnabled = useFeatureFlag("branchCreationToggle");

  if (
    !showSkipArchive &&
    !showSkipSetup &&
    !showCheckpoint &&
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
    [shouldUseCookieValues, setSkipSetupCookie],
  );

  const setDisableGitCheckpointing = useCallback(
    (value: boolean) => {
      setDisableGitCheckpointingLocal(value);
      if (shouldUseCookieValues) {
        setDisableGitCheckpointingCookie(value);
      }
    },
    [shouldUseCookieValues, setDisableGitCheckpointingCookie],
  );

  const setCreateNewBranch = useCallback(
    (value: boolean) => {
      setCreateNewBranchState(value);
      if (shouldUseCookieValues) {
        setCreateNewBranchCookie(value);
      }
    },
    [shouldUseCookieValues, setCreateNewBranchCookie],
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
