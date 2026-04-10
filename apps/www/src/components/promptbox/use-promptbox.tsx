import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { DBUserMessage } from "@leo/shared";
import type { AIAgent, AIModel, SelectedAIModels } from "@leo/agent/types";
import { useLocalStorage } from "usehooks-ts";
import { useSelectedModel } from "@/hooks/use-selected-model";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { JSONContent, useEditor } from "@tiptap/react";
import { getAgentSlashCommands, modelToAgent } from "@leo/agent/utils";
import {
  uploadImageToR2,
  uploadPdfToR2,
  uploadTextFileToR2,
} from "@/lib/r2-file-upload-client";
import { Attachment } from "@/lib/attachment-types";
import StarterKit from "@tiptap/starter-kit";
import {
  FolderAwareMention,
  folderAwareMentionPluginKey,
} from "./folder-aware-mention";
import { SlashCommand, slashCommandPluginKey } from "./slash-command-extension";
import Placeholder from "@tiptap/extension-placeholder";
import { ReactRenderer } from "@tiptap/react";
import tippy, { Instance as TippyInstance } from "tippy.js";
import { MentionList } from "@/components/promptbox/mention-list";
import { SlashCommandList } from "./slash-command-list";
import { Typeahead } from "./typeahead/typeahead";
import { tiptapToRichText } from "./tiptap-to-richtext";
import { TSubmitForm } from "./send-button";
import { mentionPillStyle } from "@/components/shared/mention-pill-styles";
import { toast } from "sonner";
import { getDynamicSlashCommands } from "./add-context-button";

export type HandleSubmitArgs = {
  userMessage: DBUserMessage;
  selectedModels: SelectedAIModels;
  repoFullName: string;
  branchName: string;
  saveAsDraft: boolean;
  scheduleAt: Parameters<TSubmitForm>[0]["scheduleAt"];
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
  initialContent?: JSONContent;
  initialSelectedModel: AIModel | null;
  persistSelectedModelToUserFlags?: boolean;
  handleStop: HandleStop;
  onUpdate?: HandleUpdate;
  handleSubmit: HandleSubmit;
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
  const { storedContent, attachedFiles, setStoredContent, setAttachedFiles } =
    useContentAndAttachedFiles({
      initialContent,
      initialFiles,
      threadId,
      storageKeyPrefix,
      disableLocalStorage,
    });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [permissionMode, setPermissionMode] = useState<"allowAll" | "plan">(
    initialPermissionMode,
  );

  // Store the query string for the current results so that we can display a
  // different message when the query string changes and the previous query
  // had no results.
  const queryStrForCurrentResultsRef = useRef<string | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

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

  // Store selectedModel in a ref so the items function can access the latest value
  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: !isTouchDevice,
    extensions: [
      StarterKit.configure({
        paragraph: {
          HTMLAttributes: {
            class: "mb-0",
          },
        },
        // Disable specific extensions to prevent markdown shortcuts
        bold: false,
        italic: false,
        code: false,
        strike: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        heading: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: placeholderText,
      }),
      FolderAwareMention.configure({
        HTMLAttributes: {
          class: mentionPillStyle,
        },
        suggestion: {
          items: async ({ query }) => {
            setIsLoadingFiles(true);
            let results: { name: string }[] = [];
            try {
              results = await typeahead.getSuggestions(query);
            } catch (error) {
              console.error("Failed to get suggestions:", error);
            } finally {
              setIsLoadingFiles(false);
            }

            queryStrForCurrentResultsRef.current = query;

            return results || [];
          },
          render: () => {
            let component: ReactRenderer<{
              onKeyDown: (props: { event: KeyboardEvent }) => boolean;
            }>;
            let popup: TippyInstance[];

            return {
              onStart: (props) => {
                component = new ReactRenderer(MentionList, {
                  props: {
                    ...props,
                    isLoadingFiles,
                    queryForCurrentResults:
                      queryStrForCurrentResultsRef.current,
                  },
                  editor: props.editor,
                });

                popup = tippy("body", {
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: "manual",
                  placement: "bottom-start",
                });
              },

              onUpdate(props) {
                component.updateProps({
                  ...props,
                  isLoadingFiles,
                  queryForCurrentResults: queryStrForCurrentResultsRef.current,
                });

                popup[0]?.setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                });
              },

              onKeyDown(props) {
                if (props.event.key === "Escape") {
                  props.event.stopPropagation();
                  popup[0]?.hide();
                  return true;
                }

                return component?.ref?.onKeyDown(props) ?? false;
              },

              onExit() {
                popup[0]?.destroy();
                component.destroy();
              },
            };
          },
        },
      }),
      SlashCommand.configure({
        HTMLAttributes: {
          class: "text-primary",
        },
        suggestion: {
          items: async ({ query }: { query: string }) => {
            const lowercaseQuery = query.toLowerCase();
            const agent = modelToAgent(selectedModelRef.current);
            const commands = getAgentSlashCommands(agent);
            const dynamicCommands = typeahead
              ? await getDynamicSlashCommands({
                  typeahead,
                  agent,
                })
              : [];
            return [...commands, ...dynamicCommands].filter((command) =>
              command.name.toLowerCase().startsWith(lowercaseQuery),
            );
          },
          command: ({ editor, range, props }: any) => {
            // Delete the range of the suggestion and insert the command as plain text
            // Adding a space after the command ensures the suggestion mode exits
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent(`/${props.id} `)
              .run();
          },
          render: () => {
            let component: ReactRenderer<{
              onKeyDown: (props: { event: KeyboardEvent }) => boolean;
            }>;
            let popup: TippyInstance[];

            return {
              onStart: (props: any) => {
                component = new ReactRenderer(SlashCommandList, {
                  props: { ...props, selectedModel: selectedModelRef.current },
                  editor: props.editor,
                });

                popup = tippy("body", {
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: "manual",
                  placement: "bottom-start",
                });
              },

              onUpdate(props: any) {
                component.updateProps({
                  ...props,
                  selectedModel: selectedModelRef.current,
                });

                popup[0]?.setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                });
              },

              onKeyDown(props: any) {
                if (props.event.key === "Escape") {
                  props.event.stopPropagation();
                  popup[0]?.hide();
                  return true;
                }

                return component?.ref?.onKeyDown(props) ?? false;
              },

              onExit() {
                popup[0]?.destroy();
                component.destroy();
              },
            };
          },
        },
      }),
    ],
    content: initialContent ?? storedContent,
    onUpdate: ({ editor }) => {
      const htmlStr = editor.getHTML();
      const isEmpty = editor.getText().length === 0;
      setStoredContent({ htmlStr, isEmpty });
      onUpdate?.({
        userMessage: getUserMessage({
          json: editor.getJSON(),
          model: selectedModel,
          attachedFiles,
        }),
      });
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none min-h-[40px] px-4 py-4 cursor-text",
      },
      handleKeyDown: (view, event) => {
        // On touch devices, we don't want to submit the form on Enter
        if (isTouchDevice) {
          return false;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          const isMentionActive = folderAwareMentionPluginKey.getState(
            view.state,
          ).active;
          const isSlashCommandActive = slashCommandPluginKey.getState(
            view.state,
          ).active;
          if (!isMentionActive && !isSlashCommandActive) {
            // On desktop devices, Enter or Cmd+Enter submits the form
            event.preventDefault();
            submitForm({ saveAsDraft: false, scheduleAt: null });
            return true;
          }
        }
        // Let Tiptap handle all other key events naturally (including Shift+Enter for newlines)
        return false;
      },
      handlePaste: (view, event, slice) => {
        // Get the clipboard data
        const clipboardData = event.clipboardData;
        if (!clipboardData) {
          return false;
        }
        // Check if we have HTML content
        const textContent = clipboardData.getData("text/plain");
        if (textContent) {
          event.preventDefault();
          // Use editor commands to insert content
          // This ensures all TipTap extensions process the content
          if (editor) {
            // Instead of using insertContent, we need to insert each line
            // then add a hard break to ensure that the lines are separated
            // properly.
            // If you edit this, please test pasting a string with newlines and then
            // editing it via backspace.
            // See also: https://github.com/ueberdosis/tiptap/issues/5501
            const lines = textContent.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              editor.commands.insertContent({ type: "text", text: line });
              if (i < lines.length - 1) {
                editor.commands.setHardBreak();
              }
            }
            editor.commands.scrollIntoView();
            // Ensure the editor is properly focused after paste
            setTimeout(() => {
              editor.commands.focus();
            }, 0);
          }

          return true;
        }

        // Let TipTap handle other paste events (like images)
        return false;
      },
    },
  });

  const getUserMessage = useCallback(
    ({
      json,
      model,
      attachedFiles,
    }: {
      json: JSONContent;
      model: AIModel;
      attachedFiles: Attachment[];
    }): DBUserMessage => {
      const richText = tiptapToRichText(json);
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

  const editorText = editor?.getText();
  const isSubmitDisabled = useMemo(() => {
    const content = editorText || "";
    return (
      content.length === 0 ||
      isSubmitting ||
      isRecording ||
      (isAgentWorking && !isQueueingEnabled) ||
      (!isSandboxProvisioned && !isQueueingEnabled)
    );
  }, [
    editorText,
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
    editor?.commands.clearContent();
    setStoredContent({ htmlStr: "", isEmpty: true });
    setAttachedFiles([]);
    onUpdate?.({
      userMessage: {
        type: "user",
        model: selectedModel,
        parts: [{ type: "rich-text", nodes: [] }],
      },
    });
  }, [editor, setStoredContent, setAttachedFiles, onUpdate, selectedModel]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    onUpdate?.({
      userMessage: getUserMessage({
        json: editor.getJSON(),
        model: selectedModel,
        attachedFiles,
      }),
    });
  }, [selectedModel, editor, onUpdate, attachedFiles, getUserMessage]);

  const getOnSubmitError = useCallback(
    ({ json, html }: { json: JSONContent; html: string }) => {
      const selectedModelCopy = selectedModel;
      const attachedFilesCopy = [...attachedFiles];
      return () => {
        editor?.commands.setContent(json);
        setStoredContent({ htmlStr: html, isEmpty: false });
        setAttachedFiles(attachedFilesCopy);
        onUpdate?.({
          userMessage: getUserMessage({
            json,
            attachedFiles: attachedFilesCopy,
            model: selectedModelCopy,
          }),
        });
      };
    },
    [
      editor,
      selectedModel,
      attachedFiles,
      setStoredContent,
      setAttachedFiles,
      onUpdate,
      getUserMessage,
    ],
  );

  const submitForm = useCallback<TSubmitForm>(
    async ({ saveAsDraft, scheduleAt }) => {
      if (isSubmitDisabled) {
        return;
      }
      if (!editor) {
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
      const json = editor.getJSON();
      const html = editor.getHTML();
      const onSubmitError = getOnSubmitError({ json, html });
      try {
        setIsSubmitting(true);
        if (clearContentBeforeSubmit) {
          clearContent();
        }
        await handleSubmit({
          userMessage: getUserMessage({
            json,
            model: selectedModel,
            attachedFiles,
          }),
          selectedModels,
          repoFullName: repoFullName ?? "",
          branchName: branchName ?? "",
          saveAsDraft,
          scheduleAt,
        });
        if (clearContentOnSubmit) {
          clearContent();
        }
      } catch (error) {
        onSubmitError();
        throw error;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      editor,
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
      getOnSubmitError,
      clearContent,
      isMultiAgentMode,
    ],
  );

  // Update editor placeholder when it changes
  useEffect(() => {
    if (editor) {
      const placeholderExtension = editor.extensionManager.extensions.find(
        (extension) => extension.name === "placeholder",
      );
      if (placeholderExtension && placeholderExtension.options) {
        placeholderExtension.options.placeholder = placeholderText;
        editor.view.dispatch(editor.state.tr);
      }
    }
  }, [editor, placeholderText]);

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
    editor,
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
  const versionSuffix = "2";

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

function useContentAndAttachedFiles({
  initialContent,
  initialFiles,
  threadId,
  storageKeyPrefix,
  disableLocalStorage,
}: {
  initialContent?: JSONContent;
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
  const [storedContentState, setStoredContentState] = useState<
    JSONContent | string
  >(initialContent ?? storedContentLocalStorage);
  const [pendingStoredContent, setPendingStoredContent] = useState<{
    htmlStr: string;
    isEmpty: boolean;
  } | null>(null);
  const flushStoredContent = useCallback(
    (nextValue: { htmlStr: string; isEmpty: boolean } | null) => {
      if (!nextValue || disableLocalStorage) {
        return;
      }
      if (nextValue.isEmpty) {
        deleteStoredContentLocalStorage();
      } else {
        setStoredContentLocalStorage(nextValue.htmlStr);
      }
    },
    [
      deleteStoredContentLocalStorage,
      disableLocalStorage,
      setStoredContentLocalStorage,
    ],
  );
  const setStoredContent = useCallback(
    ({ htmlStr, isEmpty }: { htmlStr: string; isEmpty: boolean }) => {
      setStoredContentState(htmlStr);
      setPendingStoredContent({ htmlStr, isEmpty });
    },
    [],
  );
  useEffect(() => {
    if (!pendingStoredContent || disableLocalStorage) {
      return;
    }
    const timeout = window.setTimeout(() => {
      flushStoredContent(pendingStoredContent);
      setPendingStoredContent(null);
    }, 500);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [disableLocalStorage, flushStoredContent, pendingStoredContent]);
  useEffect(() => {
    return () => {
      flushStoredContent(pendingStoredContent);
    };
  }, [flushStoredContent, pendingStoredContent]);
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
    storedContent: storedContentState,
    setStoredContent,
    attachedFiles: attachedFilesState,
    setAttachedFiles: setAttachedFilesState,
  };
}
