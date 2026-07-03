"use client";

import { useState } from "react";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

const LOCAL_STORAGE_FLAG = "terragon.transcriptStoreView";

function readLocalOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCAL_STORAGE_FLAG) === "1";
  } catch {
    return false;
  }
}

export function useTranscriptStoreViewEnabled(): boolean {
  const flag = useFeatureFlag("transcriptStoreView");
  const [override] = useState(readLocalOverride);
  return flag || override;
}
