/**
 * Builds Claude Code settings.json with a Stop hook that runs
 * quality checks before allowing the agent to stop.
 */
export function buildClaudeCodeSettings(): string {
  const settings = {
    hooks: {
      Stop: [
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
      ],
    },
  };

  return JSON.stringify(settings, null, 2);
}
