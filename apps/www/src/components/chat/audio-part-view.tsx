"use client";

import React, { useMemo } from "react";
import type { DBAudioPart } from "@terragon/shared";

export interface AudioPartViewProps {
  part: DBAudioPart;
}

export function AudioPartView({ part }: AudioPartViewProps) {
  // Build a playable URL from data (base64) or uri
  const audioSrc = useMemo(() => {
    if (part.data) {
      // data is base64-encoded — convert to a data URL
      return `data:${part.mimeType};base64,${part.data}`;
    }
    if (part.uri) {
      return part.uri;
    }
    return null;
  }, [part.data, part.uri, part.mimeType]);

  if (!audioSrc) {
    return (
      <div className="text-sm text-muted-foreground italic">
        Audio unavailable (no source)
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        controls
        src={audioSrc}
        className="max-w-full"
        data-testid="audio-element"
      />
      <span className="text-xs text-muted-foreground">{part.mimeType}</span>
    </div>
  );
}
