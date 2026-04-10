import type { StoryDefault, Story } from "@ladle/react";
import { SimplePromptBox } from "./simple-promptbox";
import { usePromptBox } from "./use-promptbox";
import { useState } from "react";
import { AIModel } from "@leo/agent/types";

export default {
  title: "PromptBox/Simple",
} satisfies StoryDefault;

function SimplePromptBoxDemo() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<AIModel>("sonnet");

  const {
    editor,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled,
    handleFilesAttached,
    removeFile,
    submitForm,
    stopThread,
    permissionMode,
    setPermissionMode,
  } = usePromptBox({
    threadId: "demo-thread",
    placeholderText:
      "Type your message here... Use @ to mention files (Enter to send)",
    repoFullName: null,
    branchName: null,
    forcedAgent: null,
    forcedAgentVersion: null,
    initialSelectedModel: null,
    supportsMultiAgentPromptSubmission: false,
    handleStop: async () => {
      setIsStreaming(false);
      console.log("Stopping thread...");
    },
    handleSubmit: async ({ userMessage }) => {
      console.log("Submitting:", { userMessage });
      setMessages((prev) => [...prev, JSON.stringify(userMessage)]);
      setIsStreaming(true);

      // Simulate streaming response
      setTimeout(() => {
        setIsStreaming(false);
      }, 2000);
    },
    typeahead: {
      getSuggestions: async (query: string) => {
        // Mock typeahead suggestions
        if (!query) return [];

        const mockFiles = [
          { name: "src/components/button.tsx" },
          { name: "src/components/input.tsx" },
          { name: "src/components/dialog.tsx" },
          { name: "src/utils/helpers.ts" },
          { name: "src/app/page.tsx" },
        ];

        return mockFiles.filter((file) =>
          file.name.toLowerCase().includes(query.toLowerCase()),
        );
      },
    },
  });

  return (
    <>
      {messages.length > 0 && (
        <div className="p-4 border-b">
          <div className="space-y-2">
            {messages.map((msg, i) => (
              <div key={i} className="text-sm p-2 bg-muted rounded">
                {msg}
              </div>
            ))}
          </div>
        </div>
      )}
      <SimplePromptBox
        editor={editor}
        attachedFiles={attachedFiles}
        handleFilesAttached={handleFilesAttached}
        removeFile={removeFile}
        forcedAgent={null}
        forcedAgentVersion={null}
        isMultiAgentMode={false}
        setIsMultiAgentMode={() => {}}
        supportsMultiAgentPromptSubmission={false}
        selectedModel={selectedModel}
        selectedModels={{}}
        setSelectedModel={({ model }: { model: AIModel }) => {
          setSelectedModel(model);
        }}
        isSubmitting={isSubmitting}
        submitForm={submitForm}
        handleStop={stopThread}
        isSubmitDisabled={isSubmitDisabled}
        showStopButton={isStreaming}
        hideSubmitButton={false}
        typeahead={null}
        className="min-h-[60px]"
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
      />
    </>
  );
}

export const Default: Story = () => {
  return <SimplePromptBoxDemo />;
};
