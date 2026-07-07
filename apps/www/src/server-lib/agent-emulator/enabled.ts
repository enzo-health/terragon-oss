export function isAgentEmulatorEnabled({
  flag = process.env.TERRAGON_AGENT_EMULATOR,
  nodeEnv = process.env.NODE_ENV,
}: {
  flag?: string;
  nodeEnv?: string;
} = {}): boolean {
  if (nodeEnv === "production") {
    return false;
  }
  return flag === "1" || flag === "true";
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export type EmulatorPacing = {
  deltaMs: number;
  stepMs: number;
  chunkChars: number;
};

export function resolveEmulatorPacing(): EmulatorPacing {
  return {
    deltaMs: readPositiveIntEnv("TERRAGON_AGENT_EMULATOR_DELTA_MS", 28),
    stepMs: readPositiveIntEnv("TERRAGON_AGENT_EMULATOR_STEP_MS", 320),
    chunkChars: Math.max(
      1,
      readPositiveIntEnv("TERRAGON_AGENT_EMULATOR_CHUNK_CHARS", 4),
    ),
  };
}
