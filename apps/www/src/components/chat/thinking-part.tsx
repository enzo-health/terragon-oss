import { memo } from "react";
import {
  ReasoningBlock,
  getReasoningTitle,
} from "@/components/ai-elements/reasoning-block";

interface ThinkingPartProps {
  thinking: string;
  isLatest?: boolean;
  isAgentWorking?: boolean;
}

export function getThinkingTitle(thinking: string): string {
  return getReasoningTitle(thinking);
}

const ThinkingPart = memo(function ThinkingPart({
  thinking,
  isLatest = false,
  isAgentWorking = false,
}: ThinkingPartProps) {
  return (
    <ReasoningBlock
      thinking={thinking}
      isLatest={isLatest}
      isAgentWorking={isAgentWorking}
    />
  );
});

export { ThinkingPart };
