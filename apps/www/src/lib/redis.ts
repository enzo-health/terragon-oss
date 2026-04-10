import { env } from "@leo/env/apps-www";
import { Redis } from "@upstash/redis";

const LOCAL_REDIS_HTTP_MODE_PORTS = new Set(["8079"]);
const LOCAL_REDIS_HTTP_TRANSPORT_PORTS = new Set(["8079", "18079"]);

function isLocalRedisHttpUrl(redisUrl: string | undefined): boolean {
  if (!redisUrl) {
    return false;
  }

  try {
    const parsed = new URL(redisUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      LOCAL_REDIS_HTTP_TRANSPORT_PORTS.has(parsed.port)
    );
  } catch {
    return false;
  }
}

const redisClientUrl = env.REDIS_URL;
const useLocalRedisHttpTransportHardening = isLocalRedisHttpUrl(redisClientUrl);

const redisClient = new Redis({
  url: redisClientUrl,
  token: env.REDIS_TOKEN,
  enableAutoPipelining: !useLocalRedisHttpTransportHardening,
});
const observedRedisKeys = new Set<string>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getObservedKeysMatchingPattern(pattern: string): string[] {
  const regex = new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*")}$`);
  return Array.from(observedRedisKeys).filter((key) => regex.test(key));
}

function recordObservedKey(action: "add" | "remove", key: string): void {
  if (!key) {
    return;
  }
  if (action === "add") {
    observedRedisKeys.add(key);
    return;
  }
  observedRedisKeys.delete(key);
}

function trackRedisKeyUsage(
  commandName: string,
  args: unknown[],
  localHttpMode: boolean,
): void {
  if (!localHttpMode) {
    return;
  }
  if (commandName === "del") {
    for (const arg of args) {
      if (typeof arg === "string") {
        recordObservedKey("remove", arg);
      }
    }
    return;
  }
  if (commandName === "pipeline" || commandName === "multi") {
    return;
  }
  const [firstArg] = args;
  if (typeof firstArg === "string") {
    recordObservedKey("add", firstArg);
  }
}

function getEffectiveRedisUrl(): string {
  return process.env.REDIS_URL?.trim() || env.REDIS_URL;
}

export function isLocalRedisHttpMode(): boolean {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  const redisUrl = getEffectiveRedisUrl();
  if (!redisUrl) {
    return false;
  }
  try {
    const parsed = new URL(redisUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      LOCAL_REDIS_HTTP_MODE_PORTS.has(parsed.port)
    );
  } catch {
    return false;
  }
}

export function isRedisTransportParseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Unexpected end of JSON input");
}

function isRetryableLocalRedisTransportError(error: unknown): boolean {
  if (isRedisTransportParseError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("time out") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createResilientRedisClient(client: Redis): Redis {
  const defaultMaxRetries = 3;
  const localHttpMaxRetries = 6;
  const localHttpCommandTimeoutMs = 3_000;
  const retryDelayMs = 10;

  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      const command = value as (...innerArgs: unknown[]) => unknown;

      const executePromiseWithRetries = async ({
        initialExecution,
        args,
        localHttpMode,
      }: {
        initialExecution: Promise<unknown>;
        args: unknown[];
        localHttpMode: boolean;
      }): Promise<unknown> => {
        const maxRetries = localHttpMode
          ? localHttpMaxRetries
          : defaultMaxRetries;
        let attempt = 0;
        let execution: Promise<unknown> = initialExecution;

        while (true) {
          try {
            if (!localHttpMode) {
              return await execution;
            }
            return await withTimeout(
              execution,
              localHttpCommandTimeoutMs,
              "Local redis-http command timeout",
            );
          } catch (error) {
            if (
              !localHttpMode ||
              !isRetryableLocalRedisTransportError(error) ||
              attempt >= maxRetries - 1
            ) {
              throw error;
            }

            attempt += 1;
            const waitMs = retryDelayMs * attempt * attempt;
            await sleep(waitMs);
            execution = Promise.resolve(Reflect.apply(command, target, args));
          }
        }
      };

      return (...args: unknown[]) => {
        const commandName =
          typeof property === "string" ? property : String(property);
        const localHttpMode = isLocalRedisHttpUrl(getEffectiveRedisUrl());
        if (localHttpMode && commandName === "keys") {
          const [patternArg] = args;
          const pattern = typeof patternArg === "string" ? patternArg : "*";
          return Promise.resolve(getObservedKeysMatchingPattern(pattern));
        }
        trackRedisKeyUsage(commandName, args, localHttpMode);

        const execution = Reflect.apply(command, target, args);
        if (!(execution instanceof Promise)) {
          return execution;
        }
        const task = () =>
          executePromiseWithRetries({
            initialExecution: execution,
            args,
            localHttpMode,
          });
        if (!localHttpMode) {
          return task();
        }
        return task();
      };
    },
  }) as Redis;
}

export const redis = createResilientRedisClient(redisClient);
