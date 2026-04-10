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
      description="Prefix added to new branch names"
      direction="col"
    >
      <div className="flex items-center gap-2">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className="h-8 w-32"
          placeholder="e.g. leo/"
        />
        {isDirty && (
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            Save
          </Button>
        )}
      </div>
    </SettingsWithCTA>
  );
}
