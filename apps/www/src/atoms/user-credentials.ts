import { atom, useAtomValue } from "jotai";
import { getUserCredentialsAction } from "@/server-actions/user-credentials";
import { AIAgent } from "@terragon/agent/types";
import { UserCredentials } from "@terragon/shared";
import { useUserCreditBalanceQuery } from "@/queries/user-credit-balance-queries";
import { isAgentSupportedForCredits } from "@terragon/agent/utils";

export const userCredentialsAtom = atom<UserCredentials | null>(null);

export const userCredentialsRefetchAtom = atom(null, async (_get, set) => {
  const credentialsResult = await getUserCredentialsAction();
  if (!credentialsResult.success) {
    console.error(credentialsResult.errorMessage);
    return;
  }
  set(userCredentialsAtom, credentialsResult.data);
});

type CredentialInfo = {
  canInvokeAgent: boolean;
  hasCredentials: boolean;
  supportsCredits: boolean;
  isOutOfCredits: boolean;
};

export function useCredentialInfoForAgent(
  agent: AIAgent,
): CredentialInfo | null {
  const credentials = useAtomValue(userCredentialsAtom);
  const supportsBuiltInCredits = isAgentSupportedForCredits(agent);
  const { data: userCreditBalance } = useUserCreditBalanceQuery({
    enabled: supportsBuiltInCredits,
  });
  if (!credentials) {
    return null;
  }
  let hasCredentials = false;
  switch (agent) {
    case "claudeCode":
      hasCredentials = credentials.hasClaude;
      break;
    case "amp":
      hasCredentials = credentials.hasAmp;
      break;
    case "codex":
      hasCredentials = credentials.hasOpenAI;
      break;
    case "gemini":
      hasCredentials = false;
      break;
    case "opencode":
      hasCredentials = false;
      break;
    case "droid":
      hasCredentials = false;
      break;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      break;
  }

  const isOutOfCredits =
    !!userCreditBalance && userCreditBalance.balanceCents <= 0;
  return {
    canInvokeAgent:
      hasCredentials || (supportsBuiltInCredits && !isOutOfCredits),
    hasCredentials,
    supportsCredits: supportsBuiltInCredits,
    isOutOfCredits: supportsBuiltInCredits && isOutOfCredits,
  };
}
