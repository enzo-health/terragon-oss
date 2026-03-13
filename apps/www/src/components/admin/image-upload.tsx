"use client";

import { useState, useCallback } from "react";
import { Upload, Copy, X } from "lucide-react";
import { generateImageUploadUrl } from "@/server-actions/admin/image-upload";
import { useDropzone } from "react-dropzone";
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
      return publicUrl;
    } catch (error) {
      console.error("Upload error:", error);
      toast.error(error instanceof Error ? error.message : "Upload failed");
      throw error;
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: uploadFile is stable via React Compiler
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
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

      try {
        await uploadFile(file);
      } catch (error) {
        // Error already handled in uploadFile
      }
    }
  }, []);

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
            <CardTitle>Image/Video Upload</CardTitle>
            <CardDescription>
              Upload images or videos (MP4, WebM, MOV) to the CDN bucket
              (cdn-terragon) at cdn.terragonlabs.com
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              {...getRootProps()}
              className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
              transition-colors duration-200
              ${isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"}
              ${uploading ? "pointer-events-none opacity-50" : "hover:border-primary hover:bg-primary/5"}
            `}
            >
              <input {...getInputProps()} />
              <Upload className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              {isDragActive ? (
                <p className="text-lg font-medium">Drop files here...</p>
              ) : (
                <>
                  <p className="text-lg font-medium mb-1">
                    Drag & drop images or videos here, or click to select
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Supports PNG, JPG, GIF, WebP, SVG, MP4, WebM, MOV (max 10MB
                    per file)
                  </p>
                </>
              )}
            </div>

            {uploading && (
              <div className="mt-4">
                <Progress value={uploadProgress} className="h-2" />
                <p className="text-sm text-muted-foreground mt-2">
                  Uploading... {Math.round(uploadProgress)}%
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {uploadedImages.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Uploaded Files</CardTitle>
              <CardDescription>
                Click the copy button to copy the CDN URL
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {uploadedImages.map((image, index) => (
                  <div
                    key={`${image.publicUrl}-${index}`}
                    className="flex items-center gap-3 p-3 border rounded-lg"
                  >
                    {image.contentType.startsWith("video/") ? (
                      <video
                        src={image.publicUrl}
                        className="w-16 h-16 object-cover rounded"
                        controls
                        muted
                        playsInline
                      />
                    ) : (
                      <img
                        src={image.publicUrl}
                        alt={image.fileName}
                        className="w-16 h-16 object-cover rounded"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {image.fileName}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {image.publicUrl}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {image.uploadedAt.toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(image.publicUrl)}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => removeImage(index)}
                      >
                        <X className="w-4 h-4" />
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
