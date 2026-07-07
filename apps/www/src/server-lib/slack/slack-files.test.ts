import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertSlackFilesToMessageParts } from "./slack-files";
import { uploadUserAttachmentBytes } from "@/lib/r2-file-upload-server";

vi.mock("@/lib/r2-file-upload-server", () => ({
  uploadUserAttachmentBytes: vi.fn(
    async ({
      fileType,
      contentType,
    }: {
      fileType: string;
      contentType: string;
    }) => `https://r2.test/${fileType}.${contentType.split("/")[1]}`,
  ),
}));

describe("convertSlackFilesToMessageParts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(new TextEncoder().encode("file bytes"), {
            status: 200,
          }),
        ),
      ),
    );
  });

  it("downloads supported Slack files with the bot token and returns R2-backed DB parts", async () => {
    const result = await convertSlackFilesToMessageParts({
      botToken: "xoxb-secret",
      userId: "user-1",
      files: [
        {
          id: "F1",
          name: "screenshot.png",
          mimetype: "image/png",
          size: 100,
          url_private_download: "https://slack.test/files/F1",
        },
        {
          id: "F2",
          name: "../design.pdf",
          mimetype: "application/pdf",
          size: 100,
          url_private: "https://slack.test/files/F2",
        },
      ],
    });

    expect(fetch).toHaveBeenCalledWith("https://slack.test/files/F1", {
      headers: { Authorization: "Bearer xoxb-secret" },
    });
    expect(fetch).toHaveBeenCalledWith("https://slack.test/files/F2", {
      headers: { Authorization: "Bearer xoxb-secret" },
    });
    expect(uploadUserAttachmentBytes).toHaveBeenCalledTimes(2);
    expect(uploadUserAttachmentBytes).toHaveBeenCalledWith({
      userId: "user-1",
      fileType: "image",
      contentType: "image/png",
      contents: expect.any(ArrayBuffer),
    });
    expect(uploadUserAttachmentBytes).toHaveBeenCalledWith({
      userId: "user-1",
      fileType: "pdf",
      contentType: "application/pdf",
      contents: expect.any(ArrayBuffer),
    });
    expect(result.skipped).toEqual([]);
    expect(result.parts).toEqual([
      {
        type: "image",
        mime_type: "image/png",
        image_url: "https://r2.test/image.png",
      },
      {
        type: "pdf",
        mime_type: "application/pdf",
        pdf_url: "https://r2.test/pdf.pdf",
        filename: "..-design.pdf",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("slack.test");
  });

  it("skips unsupported and oversized files without downloading them", async () => {
    const result = await convertSlackFilesToMessageParts({
      botToken: "xoxb-secret",
      userId: "user-1",
      files: [
        {
          id: "F1",
          name: "archive.zip",
          mimetype: "application/zip",
          size: 100,
          url_private_download: "https://slack.test/files/F1",
        },
        {
          id: "F2",
          name: "large.txt",
          mimetype: "text/plain",
          size: 11 * 1024 * 1024,
          url_private_download: "https://slack.test/files/F2",
        },
      ],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(uploadUserAttachmentBytes).not.toHaveBeenCalled();
    expect(result.parts).toEqual([]);
    expect(result.skipped).toEqual([
      { fileName: "archive.zip", reason: "unsupported-type" },
      { fileName: "large.txt", reason: "unsupported-type" },
    ]);
  });
});
