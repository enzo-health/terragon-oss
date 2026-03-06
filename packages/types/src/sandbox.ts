// NOTE: This is stored in the database, so don't remove any values from this list.
export type SandboxProvider =
  | "e2b"
  | "docker"
  | "mock"
  | "daytona"
  | "opensandbox";

// Generic sandbox size - applies to all providers
// NOTE: This is stored in the database, so don't remove any values from this list.
export type SandboxSize = "small" | "large";
