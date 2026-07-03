import type { FC } from "react";
import type { TranscriptItem } from "../transcript-store";

export type LeafItem<K extends TranscriptItem["kind"]> = Extract<
  TranscriptItem,
  { kind: K }
>;

export type LeafProps<K extends TranscriptItem["kind"]> = {
  readonly item: LeafItem<K>;
};

export type Leaf<K extends TranscriptItem["kind"]> = FC<LeafProps<K>>;
