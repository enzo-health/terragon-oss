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

  return (
    <DragDropWrapper
      onFilesDropped={handleFilesAttached}
      className={cn(
        "flex flex-col gap-2 rounded-[calc(var(--radius)+0.2rem)] border border-border/70 bg-card p-2 shadow-sm transition-[border-color,box-shadow] duration-200 ease-[var(--ease-standard)] hover:shadow-md focus-within:border-primary/25 focus-within:shadow-lg",
        borderClassName,
      )}
    >
      <ScrollArea
        className="max-h-[min(60dvh,28rem)] overflow-auto"
        onClick={() => {
          // Focus editor when clicking in the scroll area
          if (editor && !editor.isFocused) {
            editor.commands.focus("end");
          }
        }}
      >
        <EditorContent
          editor={editor}
          className={cn("min-h-[44px] px-3 pb-1.5 pt-2.5 md:px-4", className)}
        />
      </ScrollArea>
      <AttachedFiles attachedFiles={attachedFiles} onRemoveFile={removeFile} />
      <div className="flex flex-row items-center gap-3 border-t border-border/60 px-2 pb-1 pt-2">
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
  );
}
