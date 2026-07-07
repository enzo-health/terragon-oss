import { useState } from "react";
import { SendButton, SendComboButton, TSubmitForm } from "./send-button";
import { StopButton } from "./stop-button";
import { SpeechToTextButton } from "./speech-to-text-button";
import { cn } from "@/lib/utils";

export function SubmitComboButton({
  onTranscript,
  isSubmitting,
  submitForm,
  handleStop,
  disabled,
  className,
  showStopButton,
  hideSubmitButton,
  initialIsProcessingAudio,
  initialIsRecording,
  onRecordingChange,
  supportSaveAsDraft,
  supportSchedule,
  hideVoiceInput = false,
}: {
  onTranscript: (transcript: string) => void;
  isSubmitting: boolean;
  submitForm: TSubmitForm;
  handleStop: () => void;
  disabled: boolean;
  className?: string;
  showStopButton: boolean;
  hideSubmitButton: boolean;
  initialIsProcessingAudio?: boolean;
  initialIsRecording?: boolean;
  onRecordingChange?: (isRecording: boolean) => void;
  supportSaveAsDraft: boolean;
  supportSchedule?: boolean;
  hideVoiceInput?: boolean;
}) {
  const [isProcessingAudio, setIsProcessingAudio] = useState(
    initialIsProcessingAudio ?? false,
  );
  const [isRecording, setIsRecording] = useState(initialIsRecording ?? false);

  const handleRecordingChange = (recording: boolean) => {
    setIsRecording(recording);
    onRecordingChange?.(recording);
  };

  const showStop = showStopButton && !isRecording && !isProcessingAudio;
  const showSend = isProcessingAudio || !hideSubmitButton;
  const useComboSend = supportSaveAsDraft || supportSchedule;
  const crossFade =
    "col-start-1 row-start-1 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-standard)]";

  return (
    <>
      {!hideVoiceInput && !isProcessingAudio && (
        <SpeechToTextButton
          onProcessing={setIsProcessingAudio}
          onTranscript={onTranscript}
          onRecordingChange={handleRecordingChange}
          initialIsRecording={initialIsRecording}
        />
      )}
      {useComboSend ? (
        showStop ? (
          <StopButton handleStop={handleStop} disabled={isSubmitting} />
        ) : showSend ? (
          <SendComboButton
            isProcessingAudio={isProcessingAudio}
            isSubmitting={isSubmitting}
            submitForm={submitForm}
            disabled={disabled || isProcessingAudio || isRecording}
            className={className}
            supportSaveAsDraft={supportSaveAsDraft}
            supportSchedule={supportSchedule}
          />
        ) : null
      ) : showStop || showSend ? (
        <div className="grid place-items-center">
          <span
            className={cn(
              crossFade,
              showStop && "opacity-0 pointer-events-none",
            )}
            inert={showStop}
          >
            <SendButton
              isProcessingAudio={isProcessingAudio}
              isSubmitting={isSubmitting}
              submitForm={submitForm}
              disabled={disabled || isProcessingAudio || isRecording}
              className={className}
            />
          </span>
          <span
            className={cn(
              crossFade,
              !showStop && "opacity-0 pointer-events-none",
            )}
            inert={!showStop}
          >
            <StopButton handleStop={handleStop} disabled={isSubmitting} />
          </span>
        </div>
      ) : null}
    </>
  );
}
