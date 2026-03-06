import type { SandboxProvider } from "@terragon/types/sandbox";

export function isSandboxTerminalSupported(sandboxProvider: SandboxProvider) {
  switch (sandboxProvider) {
    case "e2b":
      return true;
    case "daytona":
      // NOTE: partykit deployment doesn't like the daytona sdk so we can't support this
      // even though daytona sdk supports a pty interface
      return false;
    case "docker":
    case "mock":
    case "opensandbox":
      return false;
    default:
      const _exhaustiveCheck: never = sandboxProvider;
      console.error(`Unknown sandbox provider: ${_exhaustiveCheck}`);
      return false;
  }
}
