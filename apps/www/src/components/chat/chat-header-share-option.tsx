"use client";

import React from "react";
import { ThreadVisibility } from "@terragon/shared";
import { Check, Lock, Users, Globe } from "lucide-react";

export function ShareOption({
  visibility,
  isSelected,
  onClick,
  disabled,
}: {
  visibility: ThreadVisibility;
  isSelected: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const getLabel = () => {
    switch (visibility) {
      case "private":
        return "Private";
      case "link":
        return "Logged in users with the link";
      case "repo":
        return "Repository members";
      default:
        const _exhaustiveCheck: never = visibility;
        return _exhaustiveCheck && false;
    }
  };

  const getIcon = () => {
    switch (visibility) {
      case "private":
        return <Lock className="h-4 w-4 mr-2" />;
      case "link":
        return <Globe className="h-4 w-4 mr-2" />;
      case "repo":
        return <Users className="h-4 w-4 mr-2" />;
      default:
        return null;
    }
  };

  return (
    <button
      key={visibility}
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center px-3 py-2 rounded-md transition-colors text-left ${
        isSelected
          ? "bg-primary/10 text-primary"
          : !disabled
            ? "hover:bg-muted"
            : ""
      } ${disabled ? "opacity-50" : ""}`}
      aria-label={`Set visibility to ${getLabel()}`}
      aria-pressed={isSelected}
      type="button"
    >
      <span aria-hidden="true">{getIcon()}</span>
      <div className="flex-1">
        <div className="text-sm">{getLabel()}</div>
      </div>
      {isSelected && <Check className="h-3 w-3" aria-label="Selected" />}
    </button>
  );
}
