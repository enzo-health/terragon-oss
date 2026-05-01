"use client";

import { memo } from "react";
import {
  RECOMMENDED_AUTOMATIONS,
  type RecommendedAutomation,
} from "./recommended-automation-templates";

interface RecommendedAutomationsProps {
  onSelect: (automation: RecommendedAutomation) => void;
}

const RecommendedAutomationItem = memo(function RecommendedAutomationItem({
  automation,
  onSelect,
}: {
  automation: RecommendedAutomation;
  onSelect: (automation: RecommendedAutomation) => void;
}) {
  return (
    <button
      onClick={() => {
        onSelect(automation);
      }}
      className="block rounded-xl transition-colors py-2 px-3 hover:bg-sunken w-full cursor-pointer"
      aria-label={`Create ${automation.label} automation`}
      type="button"
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 flex-shrink-0 flex items-center justify-center"
            aria-hidden="true"
          >
            {automation.icon}
          </div>
          <p className="text-sm truncate font-medium text-foreground">
            {automation.label}
          </p>
        </div>
      </div>
    </button>
  );
});

export const RecommendedAutomations = memo(function RecommendedAutomations({
  onSelect,
}: RecommendedAutomationsProps) {
  return (
    <div className="w-full" role="list" aria-label="Suggested automations">
      <div className="space-y-0">
        {RECOMMENDED_AUTOMATIONS.map((automation) => (
          <div key={automation.id} role="listitem">
            <RecommendedAutomationItem
              automation={automation}
              onSelect={onSelect}
            />
          </div>
        ))}
      </div>
    </div>
  );
});
