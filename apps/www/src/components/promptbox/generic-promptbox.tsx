"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePromptBox, HandleSubmit, HandleUpdate } from "./use-promptbox";
import { useRepositoryCache } from "./typeahead/repository-cache";
import { AIAgent } from "@leo/agent/types";
import { DBRichTextNode, DBRichTextPart, DBUserMessage } from "@leo/shared";
import { SimplePromptBox } from "./simple-promptbox";
import { richTextToTiptap } from "./tiptap-to-richtext";
import { cn } from "@/lib/utils";
import { Attachment } from "@/lib/attachment-types";

function getInitialRichText(message: DBUserMessage): DBRichTextPart {
  const nodes: DBRichTextNode[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      nodes.push({ type: "text", text: part.text });
    }
    if (part.type === "rich-text") {
      nodes.push(...part.nodes);
    }
  }
  if (nodes.length === 0) {
    nodes.push({ type: "text", text: "" });
  }
  return {
    type: "rich-text" as const,
    nodes,
  };
}

export function GenericPromptBox({
  message,
  className,
  repoFullName,
  branchName,
  forcedAgent,
  forcedAgentVersion,
  onSubmit,
  onUpdate,
  placeholder,
  autoFocus,
  hideSubmitButton,
  clearContentOnSubmit = true,
  borderClassName,
  supportSaveAsDraft,
  supportSchedule,
  supportMultiAgentPromptSubmission,
  hideModelSelector = false,
  hideModeSelector = false,
  hideAddContextButton = false,
  hideFileAttachmentButton = false,
  hideVoiceInput = false,
}: {
  message: DBUserMessage;
  className?: string;
  repoFullName: string;
  branchName: string;
  forcedAgent: AIAgent | null;
  forcedAgentVersion: number | null;
  onSubmit: HandleSubmit;
  onUpdate?: HandleUpdate;
  placeholder: string;
  autoFocus: boolean;
  hideSubmitButton: boolean;
  clearContentOnSubmit?: boolean;
  borderClassName?: string;
  supportSaveAsDraft?: boolean;
  supportSchedule?: boolean;
  supportMultiAgentPromptSubmission?: boolean;
  hideModelSelector?: boolean;
  hideModeSelector?: boolean;
  hideAddContextButton?: boolean;
  hideFileAttachmentButton?: boolean;
  hideVoiceInput?: boolean;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const repositoryCache = useRepositoryCache({
    repoFullName,
    branchName,
  });
  const initialFiles = useMemo(() => {
    const files: Attachment[] = [];
    message.parts.forEach((part, index) => {
      const id = `existing-${part.type}-${index}`;
      if (part.type === "image" && part.image_url.startsWith("http")) {
        files.push({
          id,
          mimeType: part.mime_type,
          fileType: "image",
          fileName: `image-${index}`,
          uploadStatus: "completed",
          r2Url: part.image_url,
        });
      }
      if (part.type === "pdf" && part.pdf_url.startsWith("http")) {
        files.push({
          id,
          mimeType: part.mime_type,
          fileType: "pdf",
          fileName: `pdf-${index}`,
          uploadStatus: "completed",
          r2Url: part.pdf_url,
        });
      }
      if (part.type === "text-file" && part.file_url.startsWith("http")) {
        files.push({
          id,
          mimeType: part.mime_type,
          fileType: "text-file",
          fileName: `text-file-${index}`,
          uploadStatus: "completed",
          r2Url: part.file_url,
        });
      }
    });
    return files;
  }, [message]);

  const {
    editor,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled,
    handleFilesAttached,
    removeFile,
    submitForm,
    permissionMode,
    setPermissionMode,
    selectedModel,
    selectedModels,
    setSelectedModel,
    isMultiAgentMode,
    setIsMultiAgentMode,
  } = usePromptBox({
    threadId: null,
    placeholderText: placeholder,
    forcedAgent,
    forcedAgentVersion,
    initialSelectedModel: message.model,
    clearContentBeforeSubmit: false,
    clearContentOnSubmit,
    requireRepoAndBranch: false,
    storageKeyPrefix: "edit-message-prompt-box",
    isAgentWorking: false,
    isSandboxProvisioned: true,
    isQueueingEnabled: false,
    handleSubmit: onSubmit,
    handleStop: async () => {},
    repoFullName,
    branchName,
    typeahead: repositoryCache,
    initialFiles,
    initialContent: richTextToTiptap(getInitialRichText(message)),
    disableLocalStorage: true,
    onUpdate,
    isRecording,
    initialPermissionMode: message.permissionMode ?? "allowAll",
    supportsMultiAgentPromptSubmission: !!supportMultiAgentPromptSubmission,
  });

  // Focus the editor when it is ready
  const initializedRef = useRef(false);
  useEffect(() => {
    if (editor && !editor.isDestroyed && !initializedRef.current) {
      if (autoFocus) {
        setTimeout(() => {
          editor.commands.focus();
        }, 50);
      }
      initializedRef.current = true;
    }
  }, [editor, autoFocus]);

  return (
    <SimplePromptBox
      editor={editor}
      forcedAgent={forcedAgent}
      forcedAgentVersion={forcedAgentVersion}
      attachedFiles={attachedFiles}
      handleFilesAttached={handleFilesAttached}
      removeFile={removeFile}
      isSubmitting={isSubmitting}
      submitForm={submitForm}
      isSubmitDisabled={isSubmitDisabled}
      handleStop={() => {}}
      showStopButton={false}
      hideSubmitButton={hideSubmitButton}
      borderClassName={borderClassName}
      className={cn("min-h-[60px]", className)}
      selectedModel={selectedModel}
      selectedModels={selectedModels}
      setSelectedModel={setSelectedModel}
      isMultiAgentMode={isMultiAgentMode}
      setIsMultiAgentMode={setIsMultiAgentMode}
      supportsMultiAgentPromptSubmission={!!supportMultiAgentPromptSubmission}
      onRecordingChange={setIsRecording}
      supportSaveAsDraft={supportSaveAsDraft}
      supportSchedule={supportSchedule}
      typeahead={repositoryCache}
      permissionMode={permissionMode}
      onPermissionModeChange={setPermissionMode}
      hideModelSelector={hideModelSelector}
      hideModeSelector={hideModeSelector}
      hideAddContextButton={hideAddContextButton}
      hideFileAttachmentButton={hideFileAttachmentButton}
      hideVoiceInput={hideVoiceInput}
    />
  );
}
