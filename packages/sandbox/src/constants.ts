import { daemonAsStr, mcpServerAsStr } from "@leo/bundled";

export function getDaemonFile() {
  return daemonAsStr;
}

export function getMcpServerFile() {
  return mcpServerAsStr;
}

export const sandboxTimeoutMs = 1000 * 60 * 15; // 15 minutes
export const leoSetupScriptTimeoutMs = 1000 * 60 * 15; // 15 minutes
// Backward-compatible alias during rename migration.
export const terragonSetupScriptTimeoutMs = leoSetupScriptTimeoutMs;
