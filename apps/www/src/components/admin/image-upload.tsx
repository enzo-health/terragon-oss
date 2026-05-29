"use client";

import { useState } from "react";
import { Upload, Copy, X } from "lucide-react";
import { generateImageUploadUrl } from "@/server-actions/admin/image-upload";
import { useDropzone } from "react-dropzone";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { cn } from "@/lib/utils";

interface UploadedImage {
  fileName: string;
  publicUrl: string;
  uploadedAt: Date;
  contentType: string;
}

export function AdminImageUpload() {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Image Upload" },
  ]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);

  const uploadFile = async (file: File) => {
    try {
      setUploading(true);
      setUploadProgress(0);

      // Get presigned URL from server
      const { presignedUrl, publicUrl } = await generateImageUploadUrl(
        file.name,
        file.type,
        file.size,
      );

      // Upload to R2
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percentComplete = (event.loaded / event.total) * 100;
          setUploadProgress(percentComplete);
        }
      });

      await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status === 200) {
            resolve(xhr.response);
          } else {
            reject(new Error(`Upload failed with status: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed"));

        xhr.open("PUT", presignedUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });

      // Add to uploaded files list
      if (publicUrl) {
        setUploadedImages((prev) => [
          {
            fileName: file.name,
            publicUrl,
            uploadedAt: new Date(),
            contentType: file.type,
          },
          ...prev,
        ]);
      }

      toast.success("File uploaded successfully!");
      setUploading(false);
      setUploadProgress(0);
      return publicUrl;
    } catch (error) {
      console.error("Upload error:", error);
      toast.error(error instanceof Error ? error.message : "Upload failed");
      setUploading(false);
      setUploadProgress(0);
      throw error;
    }
  };

  const onDrop = async (acceptedFiles: File[]) => {
    const validFiles: File[] = [];

    for (const file of acceptedFiles) {
      const isImage = file.type.startsWith("image/");
      const isSupportedVideo =
        file.type === "video/mp4" ||
        file.type === "video/webm" ||
        file.type === "video/quicktime";
      if (!isImage && !isSupportedVideo) {
        toast.error(`${file.name} is not supported (image, MP4, WebM, or MOV)`);
        continue;
      }

      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} is larger than 10MB`);
        continue;
      }

      validFiles.push(file);
    }

    await validFiles.reduce<Promise<void>>(
      (previousUpload, file) =>
        previousUpload.then(async () => {
          try {
            await uploadFile(file);
          } catch {
            // Error already handled in uploadFile
          }
        }),
      Promise.resolve(),
    );
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
      "video/mp4": [".mp4"],
      "video/webm": [".webm"],
      "video/quicktime": [".mov"],
    },
    multiple: true,
  });

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied!");
    } catch (error) {
      toast.error("Failed to copy URL");
    }
  };

  const removeImage = (index: number) => {
    setUploadedImages((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Image and video upload</CardTitle>
            <CardDescription>
              Upload images or videos (MP4, WebM, MOV) to the CDN bucket
              (cdn-terragon) at cdn.terragonlabs.com
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              {...getRootProps()}
              className={cn(
                "cursor-pointer rounded-xl border border-dashed border-border p-8 text-center transition-colors duration-150",
                isDragActive && "border-coral bg-coral/5",
                uploading
                  ? "pointer-events-none opacity-50"
                  : "hover:border-coral/60 hover:bg-sunken",
              )}
            >
              <input
                {...getInputProps({
                  "aria-label": "Upload images or videos",
                })}
                title="Upload images or videos"
              />
              <Upload className="mx-auto mb-4 size-10 text-muted-foreground" />
              {isDragActive ? (
                <p className="text-sm font-medium text-foreground">
                  Drop files to upload
                </p>
              ) : (
                <>
                  <p className="mb-1 text-sm font-medium text-foreground">
                    Drop images or videos here, or click to select
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PNG, JPG, GIF, WebP, SVG, MP4, WebM, MOV. Max 10MB per file.
                  </p>
                </>
              )}
            </div>

            {uploading && (
              <div className="mt-4">
                <Progress value={uploadProgress} className="h-1.5" />
                <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                  Uploading {Math.round(uploadProgress)}%
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {uploadedImages.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Uploaded files</CardTitle>
              <CardDescription>
                Copy the CDN URL or remove the entry from this session.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border rounded-xl border border-border">
                {uploadedImages.map((image, index) => (
                  <div
                    key={`${image.publicUrl}-${image.uploadedAt.toISOString()}`}
                    className="flex items-center gap-3 p-3"
                  >
                    {image.contentType.startsWith("video/") ? (
                      <video
                        src={image.publicUrl}
                        className="size-14 rounded-md object-cover"
                        aria-label={`Preview ${image.fileName}`}
                        controls
                        muted
                        playsInline
                      />
                    ) : (
                      <Image
                        src={image.publicUrl}
                        alt={image.fileName}
                        width={56}
                        height={56}
                        className="size-14 rounded-md object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {image.fileName}
                      </p>
                      <p className="truncate font-mono text-xs tabular-nums text-muted-foreground">
                        {image.publicUrl}
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {image.uploadedAt.toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(image.publicUrl)}
                        aria-label="Copy URL"
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => removeImage(index)}
                        aria-label="Remove from list"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
