"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingsWithCTA } from "./settings-row";

export interface BranchPrefixSettingProps {
  value: string;
  onSave: (prefix: string) => Promise<void>;
}

export function BranchPrefixSetting({
  value,
  onSave,
}: BranchPrefixSettingProps) {
  const [prefix, setPrefix] = useState(value);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = prefix !== value;

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave(prefix);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsWithCTA
      label="Branch name prefix"
      description="Prefix added to new branch names."
      direction="col"
    >
      <div className="flex items-center gap-2">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className="w-40"
          placeholder="e.g. terragon/"
        />
        <div
          className="transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
          style={{
            opacity: isDirty ? 1 : 0,
            transform: isDirty ? "translateX(0)" : "translateX(-4px)",
            pointerEvents: isDirty ? "auto" : "none",
          }}
          aria-hidden={!isDirty}
        >
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            className="transition-[transform,opacity,background-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] active:scale-[0.96]"
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </SettingsWithCTA>
  );
}
