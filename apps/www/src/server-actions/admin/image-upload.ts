"use server";

import { r2Cdn } from "@/lib/r2-cdn";
import { adminOnly } from "@/lib/auth-server";
import * as z from "zod/v4";
import { nanoid } from "nanoid";
import { User } from "@leo/shared";

const imageUploadSchema = z.object({
  fileName: z.string(),
  contentType: z
    .string()
    .refine(
      (type) =>
        type.startsWith("image/") ||
        type === "video/mp4" ||
        type === "video/webm" ||
        type === "video/quicktime",
      "Only image, MP4, WebM, or QuickTime video files are allowed",
    ),
  fileSize: z
    .number()
    .max(10 * 1024 * 1024, "File size must be less than 10MB"),
});

export const generateImageUploadUrl = adminOnly(
  async function generateImageUploadUrl(
    adminUser: User,
    fileName: string,
    contentType: string,
    fileSize: number,
  ) {
    const validation = imageUploadSchema.safeParse({
      fileName,
      contentType,
      fileSize,
    });

    if (!validation.success) {
      throw new Error(
        (validation.error.issues?.[0]?.message as string | undefined) ||
          "Validation failed",
      );
    }

    const fileExtension = fileName.split(".").pop() || "bin";
    const fileNameWithoutExt =
      fileName.substring(0, fileName.lastIndexOf(".")) || fileName;
    const uniqueFileName = `${fileNameWithoutExt}-${nanoid(4)}.${fileExtension}`;

    const { presignedUrl, r2Key } = await r2Cdn.generatePresignedUploadUrl(
      uniqueFileName,
      contentType,
      undefined,
      { skipPrefix: true },
    );

    const publicUrl = r2Cdn.getPublicR2Url(r2Key);

    return {
      presignedUrl,
      publicUrl,
      fileName: uniqueFileName,
    };
  },
);
