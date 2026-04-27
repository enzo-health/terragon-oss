import { default as React, memo } from "react";
import { ReasoningBlock } from "@/components/ai-elements/reasoning-block";

interface ThinkingPartProps {
  thinking: string;
  isLatest?: boolean;
  isAgentWorking?: boolean;
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
