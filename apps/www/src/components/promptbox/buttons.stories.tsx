import type { Story, StoryDefault } from "@ladle/react";
import { SubmitComboButton } from "./submit-combo-button";

export default {
  title: "PromptBox/Buttons",
} satisfies StoryDefault;

export const ButtonsSideBySide: Story = () => {
  const hideSubmitButton = false;
  const supportSaveAsDraft = false;
  return (
    <div className="grid grid-cols-2 gap-4 p-4 max-w-2xl mx-auto">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Disabled</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={true}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Default (Enabled)</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Submitting</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={true}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Recording</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            initialIsRecording={true}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Processing Audio</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            initialIsProcessingAudio={true}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
    </div>
  );
};

export const ButtonsSideBySideWithDraftsAndSchedules: Story = () => {
  const hideSubmitButton = false;
  const supportSaveAsDraft = true;
  return (
    <div className="grid grid-cols-2 gap-4 p-4 max-w-2xl mx-auto">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Disabled</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={true}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Default (Enabled)</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Submitting</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={true}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Recording</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            initialIsRecording={true}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Processing Audio</label>
        <div className="flex items-center gap-1 border border-hairline rounded-md p-2">
          <SubmitComboButton
            onTranscript={() => console.log("Transcript clicked")}
            submitForm={() => console.log("Submit clicked")}
            disabled={false}
            isSubmitting={false}
            handleStop={() => console.log("Stop clicked")}
            showStopButton={false}
            initialIsProcessingAudio={true}
            hideSubmitButton={hideSubmitButton}
            supportSaveAsDraft={supportSaveAsDraft}
          />
        </div>
      </div>
    </div>
  );
};
