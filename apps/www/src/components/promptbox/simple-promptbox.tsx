"use client";

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { SetSelectedModel } from "@/hooks/use-selected-model";

import {
  isImageUploadSupported,
  isPlanModeSupported,
} from "@terragon/agent/utils";
import {
  Composer,
  ComposerToolbar,
  ComposerToolbarSpacer,
} from "@/components/ai/composer";
import {
  ComposerRichInput,
  ComposerSuggestions,
  type ComposerTrigger,
  type ComposerValue,
} from "@/components/ai/composer-rich";
import { AttachedFiles } from "@/components/promptbox/attached-files";
import { DragDropWrapper } from "@/components/promptbox/drag-drop-wrapper";
import { ModelSelector } from "../model-selector";
import { SubmitComboButton } from "./submit-combo-button";
import { Attachment } from "@/lib/attachment-types";
import { AddContextButton } from "./add-context-button";
import { FileAttachmentButton } from "./file-attachment-button";
import { Typeahead } from "./typeahead/typeahead";
import { ModeSelector } from "@/components/promptbox/mode-selector";
import { TSubmitForm } from "./send-button";
import type { ComposerHandle } from "./use-promptbox";

export function SimplePromptBox({
  value,
  onValueChange,
  triggers,
  placeholder,
  autoFocus,
  composerRef,
  insertText,
  insertMention,
  insertSlashCommand,
  attachedFiles,
  handleFilesAttached,
  removeFile,
  isSubmitting,
  submitForm,
  handleStop,
  selectedModel,
  selectedModels,
  setSelectedModel,
  isMultiAgentMode,
  setIsMultiAgentMode,
  supportsMultiAgentPromptSubmission,
  isSubmitDisabled,
  showStopButton,
  hideSubmitButton,
  className,
  borderClassName,
  onRecordingChange,
  forcedAgent,
  forcedAgentVersion,
  typeahead,
  supportSaveAsDraft,
  supportSchedule,
  permissionMode,
  onPermissionModeChange,
  hideModelSelector = false,
  hideModeSelector = false,
  hideAddContextButton = false,
  hideFileAttachmentButton = false,
  hideVoiceInput = false,
}: {
  forcedAgent: AIAgent | null;
  forcedAgentVersion: number | null;
  value: ComposerValue;
  onValueChange: (value: ComposerValue) => void;
  triggers: Record<string, ComposerTrigger>;
  placeholder: string;
  autoFocus: boolean;
  composerRef: React.RefObject<ComposerHandle | null>;
  insertText: (text: string) => void;
  insertMention: (name: string) => void;
  insertSlashCommand: (name: string) => void;
  attachedFiles: Attachment[];
  isSubmitting: boolean;
  submitForm: TSubmitForm;
  handleStop: () => void;
  isMultiAgentMode: boolean;
  setIsMultiAgentMode: (isMultiAgentMode: boolean) => void;
  supportsMultiAgentPromptSubmission: boolean;
  selectedModel: AIModel;
  selectedModels: SelectedAIModels;
  setSelectedModel: SetSelectedModel;
  isSubmitDisabled: boolean;
  showStopButton: boolean;
  handleFilesAttached: (files: Attachment[]) => void;
  removeFile: (id: string) => void;
  className: string;
  hideSubmitButton: boolean;
  borderClassName?: string;
  onRecordingChange?: (isRecording: boolean) => void;
  typeahead: Typeahead | null;
  supportSaveAsDraft?: boolean;
  supportSchedule?: boolean;
  permissionMode: "allowAll" | "plan";
  onPermissionModeChange: (mode: "allowAll" | "plan") => void;
  hideModelSelector?: boolean;
  hideModeSelector?: boolean;
  hideAddContextButton?: boolean;
  hideFileAttachmentButton?: boolean;
  hideVoiceInput?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    composerRef.current = {
      focus: () => {
        wrapperRef.current
          ?.querySelector<HTMLElement>('[data-slot="composer-rich-input"]')
          ?.focus();
      },
    };
    return () => {
      composerRef.current = null;
    };
  }, [composerRef]);

  const showPlanModeSelector = useMemo(() => {
    if (isMultiAgentMode) {
      const selectedModelsArr = Object.keys(selectedModels) as AIModel[];
      return (
        selectedModelsArr.length > 0 &&
        selectedModelsArr.every((model) => isPlanModeSupported(model))
      );
    }
    return isPlanModeSupported(selectedModel);
  }, [isMultiAgentMode, selectedModel, selectedModels]);
  const showImageUploads = useMemo(() => {
    if (isMultiAgentMode) {
      const selectedModelsArr = Object.keys(selectedModels) as AIModel[];
      return (
        selectedModelsArr.length > 0 &&
        selectedModelsArr.every((model) => isImageUploadSupported(model))
      );
    }
    return isImageUploadSupported(selectedModel);
  }, [isMultiAgentMode, selectedModel, selectedModels]);

  const handleSpeechTranscript = useCallback(
    (transcript: string) => {
      insertText(transcript + " ");
    },
    [insertText],
  );

  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitForm({ saveAsDraft: false, scheduleAt: null });
    },
    [submitForm],
  );

  const handleSubmitValue = useCallback(() => {
    submitForm({ saveAsDraft: false, scheduleAt: null });
  }, [submitForm]);

  return (
    <form onSubmit={handleFormSubmit}>
      <DragDropWrapper
        onFilesDropped={handleFilesAttached}
        className={cn(
          "relative flex flex-col gap-1 rounded-[var(--radius-outer)] border border-border bg-surface shadow-xs transition-[box-shadow,border-color] duration-[var(--duration-base)] ease-[var(--ease-standard)] focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/40",
          isSubmitting &&
            "pointer-events-none cursor-wait border-primary/30 bg-primary/[0.02]",
          borderClassName,
        )}
      >
        {isSubmitting && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-primary/20 overflow-hidden rounded-t-[var(--radius-outer)]">
            <div className="h-full bg-primary/60 animate-shimmer w-1/2" />
          </div>
        )}
        <div ref={wrapperRef} className="flex flex-col gap-1">
          <Composer
            disabled={isSubmitting}
            className="rounded-none border-0 bg-transparent shadow-none focus-within:ring-0 focus-within:border-transparent"
          >
            <ComposerRichInput
              value={value}
              onValueChange={onValueChange}
              onSubmit={handleSubmitValue}
              triggers={triggers}
              placeholder={placeholder}
              autoFocus={autoFocus}
              className={cn("text-sm leading-relaxed", className)}
            />
            <ComposerSuggestions />
            <AttachedFiles
              attachedFiles={attachedFiles}
              onRemoveFile={removeFile}
            />
            <ComposerToolbar className="px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-row items-center gap-1.5">
                {!hideAddContextButton && (
                  <AddContextButton
                    onInsertMention={insertMention}
                    onInsertSlashCommand={insertSlashCommand}
                    typeahead={typeahead ?? undefined}
                    selectedModel={selectedModel}
                    onAttachImages={
                      !showImageUploads ? undefined : handleFilesAttached
                    }
                  />
                )}
                {!hideFileAttachmentButton && showImageUploads && (
                  <FileAttachmentButton
                    className="flex-initial hidden xs:flex"
                    onFileAttachment={(file) => handleFilesAttached([file])}
                  />
                )}
                {!hideModeSelector &&
                  showPlanModeSelector &&
                  onPermissionModeChange && (
                    <ModeSelector
                      mode={permissionMode ?? "allowAll"}
                      onChange={onPermissionModeChange}
                    />
                  )}
              </div>
              <ComposerToolbarSpacer className="flex min-w-0 flex-shrink flex-row items-center gap-1.5">
                {!hideModelSelector && (
                  <ModelSelector
                    className="flex-initial"
                    selectedModel={selectedModel}
                    selectedModels={selectedModels}
                    setSelectedModel={setSelectedModel}
                    forcedAgent={forcedAgent}
                    forcedAgentVersion={forcedAgentVersion}
                    isMultiAgentMode={isMultiAgentMode}
                    setIsMultiAgentMode={setIsMultiAgentMode}
                    supportsMultiAgentPromptSubmission={
                      supportsMultiAgentPromptSubmission
                    }
                  />
                )}
                <SubmitComboButton
                  onTranscript={handleSpeechTranscript}
                  isSubmitting={isSubmitting}
                  submitForm={submitForm}
                  handleStop={handleStop}
                  disabled={isSubmitDisabled}
                  hideSubmitButton={hideSubmitButton}
                  showStopButton={showStopButton}
                  onRecordingChange={onRecordingChange}
                  supportSaveAsDraft={!!supportSaveAsDraft}
                  supportSchedule={!!supportSchedule}
                  hideVoiceInput={hideVoiceInput}
                />
              </ComposerToolbarSpacer>
            </ComposerToolbar>
          </Composer>
        </div>
      </DragDropWrapper>
    </form>
  );
}
