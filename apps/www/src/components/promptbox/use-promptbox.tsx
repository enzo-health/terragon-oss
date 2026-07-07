import type { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import { getAgentSlashCommands, modelToAgent } from "@terragon/agent/utils";
import type { DBUserMessage } from "@terragon/shared";
import { File as FileIcon, Folder as FolderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocalStorage } from "usehooks-ts";
import type {
  ComposerItem,
  ComposerTrigger,
  ComposerValue,
} from "@/components/ai/composer-rich";
import { useSelectedModel } from "@/hooks/use-selected-model";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { Attachment } from "@/lib/attachment-types";
import {
  uploadImageToR2,
  uploadPdfToR2,
  uploadTextFileToR2,
} from "@/lib/r2-file-upload-client";
import { getDynamicSlashCommands } from "./add-context-button";
import {
  type ComposerOptimisticSubmit,
  routeComposerSubmit,
} from "./composer-submit-routing";
import { composerValueToRichText } from "./composer-richtext";
import {
  appendChip,
  appendSlashCommand,
  appendText,
  EMPTY_COMPOSER_VALUE,
  isComposerValueEmpty,
} from "./composer-value";
import { TSubmitForm } from "./send-button";
import { Typeahead } from "./typeahead/typeahead";

export type ComposerHandle = {
  focus: () => void;
};

export type HandleSubmitArgs = {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
  clientSubmissionId: string;
};

export type HandleUpdateArgs = {
  userMessage: DBUserMessage;
};

export type HandleSubmit = (args: HandleSubmitArgs) => Promise<void>;
export type HandleUpdate = (args: HandleUpdateArgs) => void;
export type HandleStop = () => Promise<void>;

interface UsePromptBoxProps {
  threadId: string | null;
  placeholderText: string;
  repoFullName: string | null;
  branchName: string | null;
  forcedAgent: AIAgent | null;
  forcedAgentVersion: number | null;
  initialContent?: ComposerValue;
  initialSelectedModel: AIModel | null;
  persistSelectedModelToUserFlags?: boolean;
  handleStop: HandleStop;
  onUpdate?: HandleUpdate;
  handleSubmit: HandleSubmit;
  optimisticSubmit?: ComposerOptimisticSubmit;
  handleQueueMessage?: HandleSubmit;
  typeahead: Typeahead;
  clearContentOnSubmit?: boolean;
  clearContentBeforeSubmit?: boolean;
  requireRepoAndBranch?: boolean;
  storageKeyPrefix?: string;
  isAgentWorking?: boolean;
  isSandboxProvisioned?: boolean;
  isQueueingEnabled?: boolean;
  initialFiles?: Attachment[];
  isRecording?: boolean;
  initialPermissionMode?: "allowAll" | "plan";
  supportsMultiAgentPromptSubmission: boolean;
  disableLocalStorage?: boolean;
}

export function usePromptBox({
  threadId,
  placeholderText,
  repoFullName,
  branchName,
  forcedAgent,
  forcedAgentVersion,
  initialContent,
  initialSelectedModel,
  persistSelectedModelToUserFlags,
  onUpdate,
  handleStop,
  handleSubmit,
  optimisticSubmit,
  handleQueueMessage,
  typeahead,
  clearContentOnSubmit = true,
  clearContentBeforeSubmit = false,
  requireRepoAndBranch = false,
  storageKeyPrefix = "prompt-box-input",
  isAgentWorking = false,
  isSandboxProvisioned = true,
  isQueueingEnabled = false,
  initialFiles = [],
  isRecording = false,
  initialPermissionMode = "allowAll",
  disableLocalStorage = false,
  supportsMultiAgentPromptSubmission,
}: UsePromptBoxProps) {
  const isTouchDevice = useTouchDevice();
  const { value, setValue, attachedFiles, setAttachedFiles } =
    useContentAndAttachedFiles({
      initialContent,
      initialFiles,
      threadId,
      storageKeyPrefix,
      disableLocalStorage,
    });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [permissionMode, setPermissionMode] = useState<"allowAll" | "plan">(
    initialPermissionMode,
  );
  useEffect(() => {
    setPermissionMode(initialPermissionMode);
  }, [initialPermissionMode]);

  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  const composerRef = useRef<ComposerHandle | null>(null);
  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  const {
    selectedModel,
    selectedModels,
    setSelectedModel,
    isMultiAgentMode,
    setIsMultiAgentMode,
  } = useSelectedModel({
    forcedAgent,
    forcedAgentVersion,
    initialSelectedModel,
    supportsMultiAgentPromptSubmission,
    persistToUserFlags: persistSelectedModelToUserFlags,
  });

  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  const valueRef = useRef(value);
  valueRef.current = value;

  const triggers = useMemo<Record<string, ComposerTrigger>>(
    () => ({
      "@": {
        action: "insert",
        filter: () => true,
        items: async (query: string): Promise<ComposerItem[]> => {
          setIsLoadingFiles(true);
          let results: { name: string; type?: "blob" | "tree" }[] = [];
          try {
            results = await typeahead.getSuggestions(query);
          } catch (error) {
            console.error("Failed to get suggestions:", error);
          } finally {
            setIsLoadingFiles(false);
          }
          return (results || []).map((item) => {
            const isFolder = item.type === "tree" || item.name.endsWith("/");
            return {
              id: item.name,
              label: item.name,
              icon: isFolder ? (
                <FolderIcon className="size-4" />
              ) : (
                <FileIcon className="size-4" />
              ),
            };
          });
        },
      },
      "/": {
        action: "execute",
        filter: (item, query) =>
          item.id.toLowerCase().startsWith(query.toLowerCase()),
        items: async (): Promise<ComposerItem[]> => {
          const agent = modelToAgent(selectedModelRef.current);
          const commands = getAgentSlashCommands(agent);
          const dynamicCommands = await getDynamicSlashCommands({
            typeahead,
            agent,
          });
          return [...commands, ...dynamicCommands].map((command) => ({
            id: command.name,
            label: command.name,
            description: command.description,
          }));
        },
        onSelect: (item, ctx) => {
          ctx.close();
          setValue((prev) => appendSlashCommand(prev, ctx.query, item.id));
          focusComposer();
        },
      },
    }),
    [typeahead, setValue, focusComposer],
  );

  const getUserMessage = useCallback(
    ({
      value,
      model,
      attachedFiles,
    }: {
      value: ComposerValue;
      model: AIModel;
      attachedFiles: Attachment[];
    }): DBUserMessage => {
      const richText = composerValueToRichText(value);
      const parts: DBUserMessage["parts"] = [richText];
      if (attachedFiles && attachedFiles.length > 0) {
        attachedFiles.forEach((file) => {
          if (file.fileType === "image") {
            parts.push({
              type: "image",
              image_url:
                file.uploadStatus === "completed" ? file.r2Url : file.base64,
              mime_type: file.mimeType,
            });
          } else if (file.fileType === "pdf") {
            parts.push({
              type: "pdf",
              pdf_url:
                file.uploadStatus === "completed" ? file.r2Url : file.base64,
              mime_type: file.mimeType,
              filename: file.fileName,
            });
          } else if (file.fileType === "text-file") {
            parts.push({
              type: "text-file",
              file_url:
                file.uploadStatus === "completed" ? file.r2Url : file.base64,
              mime_type: file.mimeType,
              filename: file.fileName,
            });
          }
        });
      }
      return {
        type: "user",
        model,
        parts,
        timestamp: new Date().toISOString(),
        permissionMode: permissionMode,
      };
    },
    [permissionMode],
  );

  const isEmpty = isComposerValueEmpty(value);
  const isSubmitDisabled = useMemo(() => {
    return (
      isEmpty ||
      isSubmitting ||
      isRecording ||
      (isAgentWorking && !isQueueingEnabled) ||
      (!isSandboxProvisioned && !isQueueingEnabled)
    );
  }, [
    isEmpty,
    isSubmitting,
    isRecording,
    isAgentWorking,
    isSandboxProvisioned,
    isQueueingEnabled,
  ]);

  const handleFilesAttached = useCallback(
    async (attachments: Attachment[]) => {
      const attachmentsCopy = [...attachments];
      setAttachedFiles((prev) => [...prev, ...attachmentsCopy]);
      const attachmentsById = new Map<string, Attachment>(
        attachmentsCopy.map((attachment) => [attachment.id, attachment]),
      );
      const uploadedAttachments = await Promise.all(
        attachmentsCopy.map(async (attachment) => {
          if (attachment.uploadStatus !== "pending") {
            return attachment;
          }
          const { file, ...restAttachment } = attachment;
          try {
            let uploadFn: (
              file: File,
            ) => Promise<{ r2Key: string; r2Url: string }>;
            if (attachment.fileType === "pdf") {
              uploadFn = uploadPdfToR2;
            } else if (attachment.fileType === "text-file") {
              uploadFn = uploadTextFileToR2;
            } else if (attachment.fileType === "image") {
              uploadFn = uploadImageToR2;
            } else {
              throw new Error(`Unsupported file type: ${attachment.fileType}`);
            }
            const { r2Url } = await uploadFn(file);
            const completedAttachment: Attachment = {
              ...restAttachment,
              r2Url,
              uploadStatus: "completed",
            };
            return completedAttachment;
          } catch (error) {
            console.error(`Failed to upload ${attachment.fileType}:`, error);
            const failedAttachment: Attachment = {
              ...restAttachment,
              uploadStatus: "failed" as const,
              uploadError:
                error instanceof Error ? error.message : "Upload failed",
            };
            return failedAttachment;
          }
        }),
      );
      for (const attachment of uploadedAttachments) {
        attachmentsById.set(attachment.id, attachment);
      }
      setAttachedFiles((prev) =>
        prev.map(
          (attachment) => attachmentsById.get(attachment.id) || attachment,
        ),
      );
    },
    [setAttachedFiles],
  );

  const removeFile = useCallback(
    (id: string) => {
      setAttachedFiles((prev) => {
        return prev.filter((file) => file.id !== id);
      });
    },
    [setAttachedFiles],
  );

  const handleFileUploadComplete = useCallback(
    (fileId: string, r2Key: string, r2Url: string) => {
      setAttachedFiles((prev) =>
        prev.map((file) =>
          file.id === fileId
            ? { ...file, r2Key, r2Url, uploadStatus: "completed" as const }
            : file,
        ),
      );
    },
    [setAttachedFiles],
  );

  const handleFileUploadError = useCallback(
    (fileId: string, error: string) => {
      setAttachedFiles((prev) => {
        return prev.map((attachment) => {
          if (
            attachment.id === fileId &&
            attachment.uploadStatus !== "completed"
          ) {
            return {
              ...attachment,
              uploadStatus: "failed" as const,
              uploadError: error,
            };
          }
          return attachment;
        });
      });
    },
    [setAttachedFiles],
  );

  const stopThread = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await handleStop();
    } finally {
      setIsSubmitting(false);
    }
  }, [handleStop]);

  const clearContent = useCallback(() => {
    setValue(EMPTY_COMPOSER_VALUE);
    setAttachedFiles([]);
    onUpdate?.({
      userMessage: {
        type: "user",
        model: selectedModel,
        parts: [{ type: "rich-text", nodes: [] }],
      },
    });
  }, [setValue, setAttachedFiles, onUpdate, selectedModel]);

  const insertText = useCallback(
    (text: string) => {
      setValue((prev) => appendText(prev, text));
      focusComposer();
    },
    [setValue, focusComposer],
  );

  const insertMention = useCallback(
    (name: string) => {
      const item: ComposerItem = { id: name, label: name };
      setValue((prev) => appendChip(prev, item));
      focusComposer();
    },
    [setValue, focusComposer],
  );

  const insertSlashCommand = useCallback(
    (name: string) => {
      setValue((prev) => appendText(prev, `/${name} `));
      focusComposer();
    },
    [setValue, focusComposer],
  );

  useEffect(() => {
    onUpdate?.({
      userMessage: getUserMessage({
        value,
        model: selectedModel,
        attachedFiles,
      }),
    });
  }, [value, selectedModel, attachedFiles, onUpdate, getUserMessage]);

  const submitForm = useCallback<TSubmitForm>(
    async ({ saveAsDraft, scheduleAt }) => {
      if (isSubmitDisabled || isSubmittingRef.current) {
        return;
      }
      if (requireRepoAndBranch && (!repoFullName || !branchName)) {
        if (!repoFullName) {
          toast.error("Please select a repository to continue");
        } else {
          toast.error("Please select a branch to continue");
        }
        return;
      }
      if (isMultiAgentMode && Object.keys(selectedModels).length === 0) {
        toast.error("Please select at least one model to continue");
        return;
      }
      const submittedValue = valueRef.current;
      const submittedFiles = [...attachedFiles];
      const submittedModel = selectedModel;
      const onSubmitError = () => {
        setValue(submittedValue);
        setAttachedFiles(submittedFiles);
        onUpdate?.({
          userMessage: getUserMessage({
            value: submittedValue,
            attachedFiles: submittedFiles,
            model: submittedModel,
          }),
        });
      };
      try {
        isSubmittingRef.current = true;
        setIsSubmitting(true);
        if (clearContentBeforeSubmit) {
          clearContent();
        }

        const userMessage = getUserMessage({
          value: submittedValue,
          model: submittedModel,
          attachedFiles: submittedFiles,
        });
        const clientSubmissionId = crypto.randomUUID();

        await routeComposerSubmit({
          userMessage,
          selectedModels,
          repoFullName: repoFullName ?? "",
          branchName: branchName ?? "",
          saveAsDraft,
          scheduleAt,
          clientSubmissionId,
          isAgentWorking,
          isQueueingEnabled,
          submitFallback: handleSubmit,
          queueMessage: handleQueueMessage,
          optimisticSubmit,
        });

        if (clearContentOnSubmit) {
          clearContent();
        }
      } catch (error) {
        onSubmitError();
        throw error;
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      getUserMessage,
      handleSubmit,
      repoFullName,
      branchName,
      requireRepoAndBranch,
      isSubmitDisabled,
      attachedFiles,
      clearContentBeforeSubmit,
      clearContentOnSubmit,
      selectedModel,
      selectedModels,
      setValue,
      setAttachedFiles,
      onUpdate,
      clearContent,
      isMultiAgentMode,
      isAgentWorking,
      isQueueingEnabled,
      handleQueueMessage,
      optimisticSubmit,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isAgentWorking) {
        event.preventDefault();
        handleStop();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [handleStop, isAgentWorking]);

  return {
    value,
    setValue,
    triggers,
    placeholder: placeholderText,
    autoFocus: !isTouchDevice,
    composerRef,
    focusComposer,
    insertText,
    insertMention,
    insertSlashCommand,
    isLoadingFiles,
    isEmpty,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled,
    handleFilesAttached,
    handleFileUploadComplete,
    handleFileUploadError,
    removeFile,
    stopThread,
    submitForm,
    permissionMode,
    setPermissionMode,
    selectedModel,
    selectedModels,
    setSelectedModel,
    isMultiAgentMode,
    setIsMultiAgentMode,
  };
}

function getStorageKey({
  threadId,
  storageKeyPrefix,
  kind,
}: {
  threadId: string | null;
  storageKeyPrefix: string;
  kind: "contents" | "attachments";
}) {
  const versionSuffix = kind === "contents" ? "3" : "2";

  if (kind === "contents") {
    return threadId
      ? `${storageKeyPrefix}-${threadId}-${versionSuffix}`
      : `${storageKeyPrefix}-draft-${versionSuffix}`;
  } else {
    return threadId
      ? `${storageKeyPrefix}-${threadId}-${kind}-${versionSuffix}`
      : `${storageKeyPrefix}-draft-${kind}-${versionSuffix}`;
  }
}

function parseStoredValue(raw: string): ComposerValue {
  if (!raw) return EMPTY_COMPOSER_VALUE;
  try {
    const parsed = JSON.parse(raw) as ComposerValue;
    if (parsed && Array.isArray(parsed.segments)) {
      return parsed;
    }
  } catch {
    return EMPTY_COMPOSER_VALUE;
  }
  return EMPTY_COMPOSER_VALUE;
}

function useContentAndAttachedFiles({
  initialContent,
  initialFiles,
  threadId,
  storageKeyPrefix,
  disableLocalStorage,
}: {
  initialContent?: ComposerValue;
  initialFiles: Attachment[];
  threadId: string | null;
  storageKeyPrefix: string;
  disableLocalStorage: boolean;
}) {
  const [
    storedContentLocalStorage,
    setStoredContentLocalStorage,
    deleteStoredContentLocalStorage,
  ] = useLocalStorage<string>(
    getStorageKey({ threadId, storageKeyPrefix, kind: "contents" }),
    "",
  );
  const [value, setValue] = useState<ComposerValue>(
    () => initialContent ?? parseStoredValue(storedContentLocalStorage),
  );
  const valueRef = useRef(value);
  valueRef.current = value;

  const persist = useCallback(
    (next: ComposerValue) => {
      if (disableLocalStorage) {
        return;
      }
      if (isComposerValueEmpty(next)) {
        deleteStoredContentLocalStorage();
      } else {
        setStoredContentLocalStorage(JSON.stringify(next));
      }
    },
    [
      deleteStoredContentLocalStorage,
      disableLocalStorage,
      setStoredContentLocalStorage,
    ],
  );

  useEffect(() => {
    if (disableLocalStorage) {
      return;
    }
    const timeout = window.setTimeout(() => {
      persist(value);
    }, 500);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [disableLocalStorage, persist, value]);

  useEffect(() => {
    return () => {
      persist(valueRef.current);
    };
  }, [persist]);

  const [
    attachedFilesLocalStorage,
    setAttachedFilesLocalStorage,
    deleteAttachedFilesLocalStorage,
  ] = useLocalStorage<Attachment[]>(
    getStorageKey({ threadId, storageKeyPrefix, kind: "attachments" }),
    [],
  );
  const [attachedFilesState, setAttachedFilesState] = useState<Attachment[]>(
    () => {
      if (initialFiles.length) {
        return initialFiles;
      }
      return attachedFilesLocalStorage;
    },
  );
  const persistAttachedFiles = useCallback(
    (files: Attachment[]) => {
      if (disableLocalStorage) {
        return;
      }
      if (files.length) {
        setAttachedFilesLocalStorage(files);
      } else {
        deleteAttachedFilesLocalStorage();
      }
    },
    [
      deleteAttachedFilesLocalStorage,
      disableLocalStorage,
      setAttachedFilesLocalStorage,
    ],
  );
  useEffect(() => {
    if (disableLocalStorage) {
      return;
    }
    const timeout = window.setTimeout(() => {
      persistAttachedFiles(attachedFilesState);
    }, 500);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [persistAttachedFiles, disableLocalStorage, attachedFilesState]);
  useEffect(() => {
    return () => {
      persistAttachedFiles(attachedFilesState);
    };
  }, [attachedFilesState, persistAttachedFiles]);
  return {
    value,
    setValue,
    attachedFiles: attachedFilesState,
    setAttachedFiles: setAttachedFilesState,
  };
}
