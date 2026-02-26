import {
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucketName: string;
  endpoint?: string;
  publicUrl?: string;
}

class R2Client {
  // private static instance: R2Client | null = null; // Singleton pattern might not be necessary for this use case, or can be re-evaluated.
  private s3Client: S3Client;
  private bucketName: string;
  private publicUrl?: string;

  public constructor(config: R2Config) {
    // Made constructor public and now takes config parameters
    const {
      accessKeyId,
      secretAccessKey,
      accountId,
      bucketName,
      publicUrl,
      endpoint,
    } = config;

    this.bucketName = bucketName;
    this.publicUrl = publicUrl;
    const r2Endpoint =
      endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
    });
  }

  // Removed static getR2Client method as client is initialized in constructor

  private toBuffer(data: Buffer | Uint8Array | string): Buffer {
    if (typeof data === "string") {
      return Buffer.from(data);
    }
    if (Buffer.isBuffer(data)) {
      return data;
    }
    return Buffer.from(data);
  }

  public async generatePresignedUploadUrl(
    filename: string,
    contentType: string,
    maxSizeInBytes?: number,
    options?: { skipPrefix?: boolean },
  ) {
    // Generate a unique key for the R2 object
    const r2Key = options?.skipPrefix
      ? filename
      : `uploads/${crypto.randomUUID()}-${filename}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: r2Key,
      ContentType: contentType,
      // Add content length range condition if maxSizeInBytes is provided
      ...(maxSizeInBytes && {
        ContentLength: maxSizeInBytes,
      }),
    });

    try {
      // The expiration time for the pre-signed URL (e.g., 15 minutes)
      const expiresInSeconds = 15 * 60;
      const presignedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      console.log(`Successfully generated pre-signed URL for ${r2Key}`);
      return { presignedUrl, r2Key };
    } catch (error) {
      console.error("Error generating pre-signed URL:", error);
      throw new Error(
        `Failed to generate R2 pre-signed URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  public async generatePresignedDownloadUrl(
    key: string,
    expiresInSeconds: number = 15 * 60,
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      return await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });
    } catch (error) {
      console.error(
        `Error generating pre-signed download URL for ${key}:`,
        error,
      );
      throw new Error(
        `Failed to generate R2 pre-signed download URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  public async uploadData({
    key,
    data,
    contentType,
    contentEncoding,
    metadata,
  }: {
    key: string;
    data: Buffer | Uint8Array | string;
    contentType: string;
    contentEncoding?: string;
    metadata?: Record<string, string>;
  }): Promise<{ key: string; size: number; etag: string | null }> {
    try {
      const body = this.toBuffer(data);
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentEncoding: contentEncoding,
        Metadata: metadata,
      });
      const response = await this.s3Client.send(command);
      return {
        key,
        size: body.byteLength,
        etag: response.ETag ?? null,
      };
    } catch (error) {
      console.error(`Error uploading data to ${key}:`, error);
      throw new Error(
        `Failed to upload to R2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  public async getObjectMetadata(key: string): Promise<{
    contentType: string | null;
    contentLength: number;
    metadata: Record<string, string>;
  }> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.s3Client.send(command);
      return {
        contentType: response.ContentType ?? null,
        contentLength: response.ContentLength ?? 0,
        metadata: response.Metadata ?? {},
      };
    } catch (error) {
      console.error(`Error fetching metadata for ${key}:`, error);
      throw new Error(
        `Failed to fetch metadata from R2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Gets the content type of an object stored in the R2 bucket
   * @param r2Key The key of the object in the R2 bucket
   * @returns The content type of the object or null if not found
   */
  public async getContentType(r2Key: string): Promise<string | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });

      const response = await this.s3Client.send(command);
      return response.ContentType || null;
    } catch (error) {
      console.error(`Error getting content type for ${r2Key}:`, error);
      // Return null instead of throwing if the object doesn't exist or there's an error
      return null;
    }
  }

  // Helper function to construct public R2 URLs.
  // If your R2 bucket is not public, you would need an action to generate presigned GET URLs instead.
  public getPublicR2Url(r2Key: string | null | undefined): string | null {
    if (!r2Key) {
      return null;
    }
    if (!this.publicUrl) {
      throw new Error(
        "Public URL not set for R2 client. Is this bucket meant to be private?",
      );
    }
    return `${this.publicUrl}/${r2Key}`;
  }

  /**
   * Deletes an object from the R2 bucket
   * @param r2Key The key of the object to delete
   */
  public async deleteObject(r2Key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });

      await this.s3Client.send(command);
      console.log(`Successfully deleted object: ${r2Key}`);
    } catch (error) {
      console.error(`Error deleting object ${r2Key}:`, error);
      throw new Error(
        `Failed to delete R2 object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Lists objects in the R2 bucket
   * @param prefix Optional prefix to filter objects
   * @param maxKeys Maximum number of keys to return (default 1000)
   * @param continuationToken Token for pagination
   */
  public async listObjects(
    prefix?: string,
    maxKeys: number = 1000,
    continuationToken?: string,
  ): Promise<{
    objects: Array<{
      key: string;
      size: number;
      lastModified: Date;
      etag?: string;
    }>;
    isTruncated: boolean;
    nextContinuationToken?: string;
  }> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);

      const objects = (response.Contents || []).map((obj) => ({
        key: obj.Key!,
        size: obj.Size || 0,
        lastModified: obj.LastModified!,
        etag: obj.ETag,
      }));

      return {
        objects,
        isTruncated: response.IsTruncated || false,
        nextContinuationToken: response.NextContinuationToken,
      };
    } catch (error) {
      console.error(`Error listing objects:`, error);
      throw new Error(
        `Failed to list R2 objects: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Downloads data from the R2 bucket
   * @param key The key/path for the object in the bucket
   * @returns The data as a Buffer
   */
  public async downloadData(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error("No data returned from R2");
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Error downloading data from ${key}:`, error);
      throw new Error(
        `Failed to download from R2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export { R2Client };
