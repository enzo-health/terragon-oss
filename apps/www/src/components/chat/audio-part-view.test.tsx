import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudioPartView } from "./audio-part-view";
import type { DBAudioPart } from "@terragon/shared";

describe("AudioPartView", () => {
  it("renders audio element with uri", () => {
    const part: DBAudioPart = {
      type: "audio",
      mimeType: "audio/mpeg",
      uri: "https://example.com/audio.mp3",
    };
    const html = renderToStaticMarkup(<AudioPartView part={part} />);
    expect(html).toContain("<audio");
    expect(html).toContain("https://example.com/audio.mp3");
    expect(html).toContain("audio/mpeg");
  });

  it("renders audio element with base64 data", () => {
    const part: DBAudioPart = {
      type: "audio",
      mimeType: "audio/wav",
      data: "UklGRiQ=",
    };
    const html = renderToStaticMarkup(<AudioPartView part={part} />);
    expect(html).toContain("<audio");
    expect(html).toContain("data:audio/wav;base64,UklGRiQ=");
  });

  it("renders unavailable message when no source", () => {
    const part: DBAudioPart = {
      type: "audio",
      mimeType: "audio/mpeg",
    };
    const html = renderToStaticMarkup(<AudioPartView part={part} />);
    expect(html).toContain("Audio unavailable");
    expect(html).not.toContain("<audio");
  });
});
