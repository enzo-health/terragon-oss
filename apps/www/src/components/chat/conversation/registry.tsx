import type { FC } from "react";
import type { TranscriptItem } from "../transcript-store";
import type { Leaf } from "./leaf-props";
import { DiffLeaf } from "./leaves/diff-leaf";
import { AttachmentLeaf, ImageLeaf } from "./leaves/media-leaves";
import { ReasoningLeaf, TextLeaf, UserLeaf } from "./leaves/message-leaves";
import { PermissionLeaf } from "./leaves/permission-leaf";
import { PlanLeaf } from "./leaves/plan-leaf";
import { SourcesLeaf } from "./leaves/sources-leaf";
import {
  CompactionLeaf,
  ErrorLeaf,
  TransientRetryLeaf,
  UnknownPartLeaf,
} from "./leaves/status-leaves";
import { DelegationLeaf, TerminalLeaf, ToolLeaf } from "./leaves/tool-leaves";

export const LEAF: { [K in TranscriptItem["kind"]]: Leaf<K> } = {
  text: TextLeaf,
  reasoning: ReasoningLeaf,
  user: UserLeaf,
  tool: ToolLeaf,
  terminal: TerminalLeaf,
  diff: DiffLeaf,
  plan: PlanLeaf,
  permission: PermissionLeaf,
  sources: SourcesLeaf,
  delegation: DelegationLeaf,
  image: ImageLeaf,
  attachment: AttachmentLeaf,
  error: ErrorLeaf,
  "transient-retry": TransientRetryLeaf,
  compaction: CompactionLeaf,
  "unknown-part": UnknownPartLeaf,
};

export function renderLeaf(item: TranscriptItem) {
  const Component = LEAF[item.kind] as FC<{ item: TranscriptItem }>;
  return <Component item={item} />;
}
