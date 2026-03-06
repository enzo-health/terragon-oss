/**
 * Builds Claude Code settings.json with a Stop hook that runs
 * quality checks before allowing the agent to stop.
 */
export function buildClaudeCodeSettings(
  options: { enableStopHook?: boolean } = {},
): string {
  const { enableStopHook = true } = options;
  const stopHooks = enableStopHook
    ? [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: "/tmp/terragon-quality-check.sh",
              timeout: 300,
            },
          ],
        },
      ]
    : [];

  const settings = {
    hooks: {
      Stop: stopHooks,
    },
  };

  return JSON.stringify(settings, null, 2);
}
