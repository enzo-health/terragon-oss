"use client";

import React, { useState, useRef, memo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Mic, AudioLines, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { transcribeAudio } from "@/server-actions/transcribe-audio";
import { uploadAudioToR2 } from "@/lib/r2-file-upload-client";
import { toast } from "sonner";
import { unwrapResult } from "@/lib/server-actions";

export const SpeechToTextButton = memo(function SpeechToTextButton({
  className,
  onProcessing,
  onTranscript,
  onRecordingChange,
  initialIsRecording,
}: {
  className?: string;
  onProcessing: (isProcessing: boolean) => void;
  onTranscript: (transcript: string) => void;
  onRecordingChange?: (isRecording: boolean) => void;
  initialIsRecording?: boolean;
}) {
  const [isProcessing, setIsProcessingInner] = useState(false);
  const [isRecording, setIsRecording] = useState(initialIsRecording ?? false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const setIsProcessing = useCallback(
    (isProcessing: boolean) => {
      setIsProcessingInner(isProcessing);
      onProcessing(isProcessing);
    },
    [onProcessing],
  );

  const startRecording = async () => {
    let stream: MediaStream | null = null;
    try {
      // Request wake lock to prevent device from sleeping
      if ("wakeLock" in navigator) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch (err) {
          console.warn("Wake Lock request failed:", err);
        }
      }

      // Request microphone permission
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create MediaRecorder with the stream
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      // Collect audio chunks
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle recording stop
      mediaRecorder.onstop = async () => {
        setIsProcessing(true);
        try {
          // Create audio blob from chunks
          const audioBlob = new Blob(audioChunksRef.current, {
            type: "audio/webm",
          });

          // Create audio file in webm format
          const audioFile = new File([audioBlob], "recording.webm", {
            type: "audio/webm",
          });

          // Client-side validation
          const maxSizeInBytes = 25 * 1024 * 1024; // 25MB
          if (audioFile.size > maxSizeInBytes) {
            throw new Error("Recording is too large. Maximum size is 25MB.");
          }

          // Upload audio file directly to R2
          const { r2Key } = await uploadAudioToR2(audioFile);

          // Now transcribe the audio using the R2 key
          const transcript = unwrapResult(
            await transcribeAudio(r2Key, audioFile.name),
          );
          if (transcript) {
            onTranscript(transcript);
          }
        } catch (error) {
          console.error("Failed to process audio:", error);
          toast.error("Failed to transcribe audio. Please try again.");
        } finally {
          setIsProcessing(false);
          // Stop all tracks to release the microphone
          stream?.getTracks().forEach((track) => track.stop());
          // Release wake lock
          if (wakeLockRef.current) {
            wakeLockRef.current.release();
            wakeLockRef.current = null;
          }
        }
      };

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
      onRecordingChange?.(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
      // Clean up the stream if it was obtained but recording failed
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        toast.error(
          "Microphone access denied. Please check your browser settings.",
        );
      } else {
        toast.error("Failed to start recording. Please try again.");
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      onRecordingChange?.(false);
      // Release wake lock immediately when stopping recording
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-11 sm:size-8", className)}
      onClick={toggleRecording}
      type="button"
      title={
        isProcessing
          ? "Processing audio…"
          : isRecording
            ? "Stop recording"
            : "Start voice input"
      }
    >
      {isProcessing ? (
        <Loader2 className="size-4 animate-spin" />
      ) : isRecording ? (
        <AudioLines className="size-4 text-destructive animate-pulse" />
      ) : (
        <Mic className="size-4" />
      )}
    </Button>
  );
});
