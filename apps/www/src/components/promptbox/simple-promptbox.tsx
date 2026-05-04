"use client";

import React, { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { SetSelectedModel } from "@/hooks/use-selected-model";

// Tiptap imports
import { EditorContent, Editor } from "@tiptap/react";

import {
  isImageUploadSupported,
  isPlanModeSupported,
} from "@terragon/agent/utils";
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

export function SimplePromptBox({
  editor,
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
  editor: Editor | null;
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
      if (!editor) {
        return;
      }
      editor.commands.insertContent({
        type: "text",
        text: transcript + " ",
      });
      editor.commands.focus();
    },
    [editor],
  );

  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitForm({ saveAsDraft: false, scheduleAt: null });
    },
    [submitForm],
  );

  return (
    <form onSubmit={handleFormSubmit}>
      <DragDropWrapper
        onFilesDropped={handleFilesAttached}
        className={cn(
          // Compact composer chrome. Outer has no padding so the editor
          // and toolbar pin directly to the border; each inner region
          // owns its own padding. Coral ring lights up on focus.
          "relative flex flex-col rounded-2xl border border-hairline bg-card shadow-[var(--shadow-warm-lift)] transition-[border-color,box-shadow,background-color,opacity] duration-300 ease-out hover:border-foreground/20 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20",
          isSubmitting && [
            "opacity-80 pointer-events-none cursor-wait border-primary/30 bg-primary/[0.02]",
            "animate-pulse-subtle",
          ],
          borderClassName,
        )}
      >
        {isSubmitting && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-primary/20 overflow-hidden rounded-t-2xl">
            <div className="h-full bg-primary/60 animate-shimmer w-1/2" />
          </div>
        )}
        <ScrollArea
          className="max-h-[min(40dvh,18rem)] overflow-auto"
          onClick={() => {
            if (editor && !editor.isFocused) {
              editor.commands.focus("end");
            }
          }}
        >
          <EditorContent
            editor={editor}
            aria-label="Describe a task for the AI"
            className={cn("min-h-10 px-2 py-1.5", className)}
          />
        </ScrollArea>
        <AttachedFiles
          attachedFiles={attachedFiles}
          onRemoveFile={removeFile}
        />
        <div className="mx-2 mb-1 flex flex-row items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-row items-center gap-1.5">
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
            {!hideModeSelector &&
              showPlanModeSelector &&
              onPermissionModeChange && (
                <ModeSelector
                  mode={permissionMode ?? "allowAll"}
                  onChange={onPermissionModeChange}
                />
              )}
          </div>
          <div className="flex flex-shrink-0 flex-row items-center gap-1.5">
            {!hideAddContextButton && (
              <AddContextButton
                editor={editor}
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
          </div>
        </div>
      </DragDropWrapper>
    </form>
  );
}
