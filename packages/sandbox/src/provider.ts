import type { SandboxProvider } from "@terragon/types/sandbox";
import type { ISandboxProvider } from "./types";
import { DockerProvider } from "./providers/docker-provider";
import { E2BProvider } from "./providers/e2b-provider";
import { MockProvider } from "./providers/mock-provider";
import { DaytonaProvider } from "./providers/daytona-provider";

export function getSandboxProvider(
  provider: SandboxProvider,
): ISandboxProvider {
  switch (provider) {
    case "e2b":
      return new E2BProvider();
    case "mock":
      if (process.env.NODE_ENV === "test") {
        return new MockProvider();
      }
      throw new Error(
        "Mock sandbox provider is only available in test environments",
      );
    case "docker":
      if (
        process.env.NODE_ENV === "test" ||
        process.env.NODE_ENV === "development"
      ) {
        return new DockerProvider();
      }
      throw new Error(
        "Docker sandbox provider is only available in test/dev environments",
      );
    case "daytona":
      return new DaytonaProvider();
    case "opensandbox":
      // OpenSandboxProvider requires DB callbacks injected at the apps/www layer.
      // Use CreateSandboxOptions.providerInstance instead of this factory.
      throw new Error(
        "OpenSandboxProvider cannot be instantiated via getSandboxProvider(). " +
          "Pass a pre-built instance via CreateSandboxOptions.providerInstance.",
      );
    default:
      const _exhaustiveCheck: never = provider;
      throw new Error(`Unknown sandbox provider: ${_exhaustiveCheck}`);
  }
}
