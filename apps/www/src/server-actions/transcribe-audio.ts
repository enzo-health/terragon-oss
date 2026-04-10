"use server";

import OpenAI from "openai";
import { env } from "@leo/env/apps-www";
import { userOnlyAction } from "@/lib/auth-server";
import { getR2ClientForFileUploadType } from "@/server-lib/r2-file-upload";
import { getPostHogServer } from "@/lib/posthog-server";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

export const transcribeAudio = userOnlyAction(
  async function transcribeAudio(
    userId: string,
    r2Key: string,
    filename: string,
  ): Promise<string> {
    getPostHogServer().capture({
      distinctId: userId,
      event: "transcribe_audio",
      properties: {},
    });
    const r2Client = getR2ClientForFileUploadType("audio");
    try {
      // Get the public URL for the uploaded file
      const publicUrl = r2Client.getPublicR2Url(r2Key);
      if (!publicUrl) {
        throw new Error(`Failed to get public URL for ${r2Key}`);
      }

      console.log("Fetching audio file from R2...");
      // Fetch the file from R2
      const audioResponse = await fetch(publicUrl);
      if (!audioResponse.ok) {
        throw new Error(
          `Failed to fetch audio from R2: ${audioResponse.statusText}`,
        );
      }

      const audioBlobData = await audioResponse.blob();
      const contentType =
        audioResponse.headers.get("content-type") || "audio/webm";

      // Log file size in megabytes
      const fileSizeInBytes = audioBlobData.size;
      const fileSizeInMB = (fileSizeInBytes / (1024 * 1024)).toFixed(2);
      console.log(`Uploaded file size: ${fileSizeInMB} MB`);

      // Create a File object for OpenAI
      const transcriptionFile = new File([audioBlobData], filename, {
        type: contentType,
      });

      console.log("Transcribing audio with OpenAI...");

      // Use whisper-1 for audio transcription
      const transcription = await openai.audio.transcriptions.create({
        file: transcriptionFile,
        model: "whisper-1",
        language: "en",
      });

      console.log("Transcription completed successfully");
      return transcription.text || "";
    } catch (error) {
      console.error("Failed to transcribe audio:", error);
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw new Error("Failed to transcribe audio");
    } finally {
      // Clean up: Delete the audio file from R2
      try {
        console.log("Cleaning up R2 file...");
        await r2Client.deleteObject(r2Key);
      } catch (cleanupError) {
        console.error("Failed to clean up R2 file:", cleanupError);
        // Don't throw here to avoid masking the original error
      }
    }
  },
  { defaultErrorMessage: "Failed to transcribe audio" },
);
