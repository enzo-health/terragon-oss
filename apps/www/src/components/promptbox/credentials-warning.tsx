"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { AIModel } from "@terragon/agent/types";
import { modelToAgent } from "@terragon/agent/utils";
import { useCredentialInfoForAgent } from "@/atoms/user-credentials";

interface CredentialsWarningProps {
  selectedModel: AIModel;
}

export function CredentialsWarning({ selectedModel }: CredentialsWarningProps) {
  const selectedAgent = modelToAgent(selectedModel);
  const credentialInfo = useCredentialInfoForAgent(selectedAgent);
  if (!credentialInfo || credentialInfo.canInvokeAgent) {
    return null;
  }
  const credentialWarningMessage = (() => {
    switch (selectedAgent) {
      case "claudeCode":
        return {
          message: "Claude credentials not configured",
          linkText: "Configure Claude",
        };
      case "gemini":
        return {
          message: "Gemini credentials not configured",
          linkText: "Configure Gemini",
        };
      case "amp":
        return {
          message: "Amp credentials not configured",
          linkText: "Configure Amp",
        };
      case "codex":
        return {
          message: "OpenAI credentials not configured",
          linkText: "Configure OpenAI",
        };
      case "opencode":
        return {
          message: "No more quota available for this model",
          linkText: null,
        };
      default:
        const _exhaustiveCheck: never = selectedAgent;
        console.warn("Unknown agent", _exhaustiveCheck);
        return null;
    }
  })();
  if (!credentialWarningMessage) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground bg-muted/50 rounded-md">
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{credentialWarningMessage.message}</span>
        {credentialWarningMessage.linkText && (
          <Link
            href="/settings/agent#agent-providers"
            className="text-foreground underline"
          >
            {credentialWarningMessage.linkText}
          </Link>
        )}
      </div>
    </div>
  );
}
