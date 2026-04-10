import { AIAgent } from "@leo/agent/types";
import Image from "next/image";
import { OpenAIIcon } from "../icons/openai";

// Helper function to render agent icon
export function AgentIcon({
  agent,
  sessionId,
}: {
  agent: AIAgent;
  sessionId: string | null;
}) {
  switch (agent) {
    case "amp":
      return sessionId ? (
        <a
          href={`https://ampcode.com/threads/${sessionId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 inline-flex items-center hover:opacity-80 transition-opacity"
        >
          <Image
            src="/ampcode.svg"
            alt="Amp Code Logo"
            width={16}
            height={16}
          />
        </a>
      ) : (
        <span className="flex-shrink-0 inline-flex items-center">
          <Image
            src="/ampcode.svg"
            alt="Amp Code Logo"
            width={16}
            height={16}
          />
        </span>
      );
    case "codex":
      return (
        <span className="flex-shrink-0 inline-flex items-center">
          <OpenAIIcon className="size-4 text-muted-foreground" />
        </span>
      );
    case "gemini":
      return (
        <span className="flex-shrink-0 inline-flex items-center">
          <Image src="/agents/gemini.png" alt="Gemini" width={18} height={18} />
        </span>
      );
    case "claudeCode":
      return (
        <span className="flex-shrink-0 inline-flex items-center">
          <Image
            src="/agents/claude-logo.svg"
            alt="Claude Code"
            width={16}
            height={16}
          />
        </span>
      );
    case "opencode":
      return (
        <span className="flex-shrink-0 inline-flex items-center">
          <Image
            src="/agents/opencode.jpg"
            alt="Opencode"
            width={18}
            height={18}
          />
        </span>
      );
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return null;
  }
}
