import { env } from "@terragon/env/apps-www";
import { Redis } from "@upstash/redis";
import type { Socket } from "node:net";

const LOCAL_REDIS_HTTP_MODE_PORTS = new Set(["8079", "18079"]);
const LOCAL_REDIS_HTTP_TRANSPORT_PORTS = new Set(["8079", "18079"]);
const LOCAL_REDIS_HTTP_TO_TCP_PORT: Record<string, number> = {
  "8079": 6379,
  "18079": 16379,
};

type RespValue = string | number | null | RespValue[];
type RespParseResult = { value: RespValue; offset: number };
type LocalRedisTcpEndpoint = { host: string; port: number };

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

const LOCAL_HTTP_COMMAND_TIMEOUT_MS = 3_000;
const LOCAL_HTTP_BLOCKING_COMMAND_TIMEOUT_BUFFER_MS = 2_000;
const LOCAL_HTTP_BLOCKING_COMMAND_TIMEOUT_CAP_MS = 30_000;

function parseBlockTimeoutMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function parseBlockTimeoutMsFromArgs(args: unknown[]): number | null {
  const blockIndex = args.findIndex(
    (arg) => typeof arg === "string" && arg.toUpperCase() === "BLOCK",
  );
  if (blockIndex >= 0 && blockIndex + 1 < args.length) {
    return parseBlockTimeoutMs(args[blockIndex + 1]);
  }

  const optionsArg = args.at(-1);
  if (
    optionsArg !== null &&
    typeof optionsArg === "object" &&
    !Array.isArray(optionsArg)
  ) {
    const blockMs =
      Reflect.get(optionsArg, "blockMS") ??
      Reflect.get(optionsArg, "blockMs") ??
      Reflect.get(optionsArg, "block");
    return parseBlockTimeoutMs(blockMs);
  }

  return null;
}

export function getLocalHttpCommandTimeoutMs(
  commandName: string,
  args: unknown[],
): number {
  const normalizedCommandName = commandName.toLowerCase();
  if (
    normalizedCommandName !== "xread" &&
    normalizedCommandName !== "xreadgroup"
  ) {
    return LOCAL_HTTP_COMMAND_TIMEOUT_MS;
  }

  const blockMs = parseBlockTimeoutMsFromArgs(args);
  if (blockMs === null) {
    return LOCAL_HTTP_COMMAND_TIMEOUT_MS;
  }

  if (blockMs === 0) {
    return LOCAL_HTTP_BLOCKING_COMMAND_TIMEOUT_CAP_MS;
  }

  return Math.min(
    Math.max(
      LOCAL_HTTP_COMMAND_TIMEOUT_MS,
      blockMs + LOCAL_HTTP_BLOCKING_COMMAND_TIMEOUT_BUFFER_MS,
    ),
    LOCAL_HTTP_BLOCKING_COMMAND_TIMEOUT_CAP_MS,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getLocalRedisTcpEndpoint(): LocalRedisTcpEndpoint | null {
  const redisUrl = getEffectiveRedisUrl();
  if (!isLocalRedisHttpUrl(redisUrl)) {
    return null;
  }

  try {
    const parsed = new URL(redisUrl);
    const port = LOCAL_REDIS_HTTP_TO_TCP_PORT[parsed.port];
    if (port === undefined) {
      return null;
    }
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function encodeRespArray(args: string[]): Buffer {
  const chunks = [`*${args.length}\r\n`];
  for (const arg of args) {
    chunks.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  }
  return Buffer.from(chunks.join(""));
}

function findLineEnd(buffer: Buffer, offset: number): number {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}

function parseResp(buffer: Buffer, offset = 0): RespParseResult | null {
  if (offset >= buffer.length) {
    return null;
  }

  const prefix = String.fromCharCode(buffer[offset]!);
  const lineEnd = findLineEnd(buffer, offset + 1);
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const nextOffset = lineEnd + 2;

  if (prefix === "+" || prefix === ":") {
    return {
      value: prefix === ":" ? Number(line) : line,
      offset: nextOffset,
    };
  }

  if (prefix === "-") {
    throw new Error(line);
  }

  if (prefix === "$") {
    const byteLength = Number(line);
    if (byteLength === -1) {
      return { value: null, offset: nextOffset };
    }
    const valueEnd = nextOffset + byteLength;
    if (buffer.length < valueEnd + 2) {
      return null;
    }
    return {
      value: buffer.subarray(nextOffset, valueEnd).toString("utf8"),
      offset: valueEnd + 2,
    };
  }

  if (prefix === "*") {
    const itemCount = Number(line);
    if (itemCount === -1) {
      return { value: null, offset: nextOffset };
    }
    const values: RespValue[] = [];
    let currentOffset = nextOffset;
    for (let index = 0; index < itemCount; index += 1) {
      const parsed = parseResp(buffer, currentOffset);
      if (parsed === null) {
        return null;
      }
      values.push(parsed.value);
      currentOffset = parsed.offset;
    }
    return { value: values, offset: currentOffset };
  }

  throw new Error(`Unsupported Redis RESP prefix: ${prefix}`);
}

async function executeLocalRedisCommand(
  endpoint: LocalRedisTcpEndpoint,
  args: string[],
  timeoutMs: number,
): Promise<RespValue> {
  const { createConnection } = await import("node:net");

  return await new Promise<RespValue>((resolve, reject) => {
    const socket: Socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Local redis stream command timeout"));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.end();
      callback();
    };

    socket.on("connect", () => {
      socket.write(encodeRespArray(args));
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      try {
        const parsed = parseResp(Buffer.concat(chunks));
        if (parsed !== null) {
          settle(() => resolve(parsed.value));
        }
      } catch (error) {
        settle(() => reject(error));
      }
    });
    socket.on("error", (error) => {
      settle(() => reject(error));
    });
    socket.on("end", () => {
      if (!settled) {
        const parsed = parseResp(Buffer.concat(chunks));
        settle(() => resolve(parsed?.value ?? null));
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localRedisFieldsFromValue(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([field, fieldValue]) => [
    field,
    typeof fieldValue === "string" ? fieldValue : JSON.stringify(fieldValue),
  ]);
}

function localRedisXreadCommandArgs(args: unknown[]): string[] | null {
  const [streamKey, lastId, options] = args;
  if (typeof streamKey !== "string" || typeof lastId !== "string") {
    return null;
  }
  const command = ["XREAD"];
  if (isRecord(options)) {
    const count = Reflect.get(options, "count");
    const blockMS = Reflect.get(options, "blockMS");
    if (typeof count === "number" && Number.isFinite(count)) {
      command.push("COUNT", String(count));
    }
    if (typeof blockMS === "number" && Number.isFinite(blockMS)) {
      command.push("BLOCK", String(blockMS));
    }
  }
  command.push("STREAMS", streamKey, lastId);
  return command;
}

function xrevrangeObjectFromResp(value: RespValue): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {};
  }
  const out: Record<string, Record<string, string>> = {};
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [id, fields] = entry;
    if (typeof id !== "string" || !Array.isArray(fields)) {
      continue;
    }
    const fieldMap: Record<string, string> = {};
    for (let index = 0; index < fields.length - 1; index += 2) {
      const field = fields[index];
      const fieldValue = fields[index + 1];
      if (typeof field === "string" && typeof fieldValue === "string") {
        fieldMap[field] = fieldValue;
      }
    }
    out[id] = fieldMap;
  }
  return out;
}

function isLocalRedisStreamCommand(commandName: string): boolean {
  const normalized = commandName.toLowerCase();
  return (
    normalized === "xadd" ||
    normalized === "xread" ||
    normalized === "xrevrange"
  );
}

function localRedisStreamCommandArgs(
  commandName: string,
  args: unknown[],
): string[] | null {
  const normalized = commandName.toLowerCase();
  if (normalized === "xadd") {
    const [streamKey, id, fields] = args;
    if (typeof streamKey !== "string" || typeof id !== "string") {
      return null;
    }
    const fieldArgs = localRedisFieldsFromValue(fields);
    if (fieldArgs.length === 0) {
      return null;
    }
    return ["XADD", streamKey, id, ...fieldArgs];
  }

  if (normalized === "xread") {
    return localRedisXreadCommandArgs(args);
  }

  if (normalized === "xrevrange") {
    const [streamKey, start, end, count] = args;
    if (
      typeof streamKey !== "string" ||
      typeof start !== "string" ||
      typeof end !== "string"
    ) {
      return null;
    }
    const command = ["XREVRANGE", streamKey, start, end];
    if (typeof count === "number" && Number.isFinite(count)) {
      command.push("COUNT", String(count));
    }
    return command;
  }

  return null;
}

async function executeLocalRedisStreamCommand(
  commandName: string,
  args: unknown[],
): Promise<unknown> {
  const endpoint = getLocalRedisTcpEndpoint();
  const command = localRedisStreamCommandArgs(commandName, args);
  if (endpoint === null || command === null) {
    return undefined;
  }
  const value = await executeLocalRedisCommand(
    endpoint,
    command,
    getLocalHttpCommandTimeoutMs(commandName, args),
  );
  return commandName.toLowerCase() === "xrevrange"
    ? xrevrangeObjectFromResp(value)
    : value;
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
        commandName,
      }: {
        initialExecution: Promise<unknown>;
        args: unknown[];
        localHttpMode: boolean;
        commandName: string;
      }): Promise<unknown> => {
        const maxRetries = localHttpMode
          ? localHttpMaxRetries
          : defaultMaxRetries;
        const localHttpCommandTimeoutMs = getLocalHttpCommandTimeoutMs(
          commandName,
          args,
        );
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
        if (localHttpMode && isLocalRedisStreamCommand(commandName)) {
          return executeLocalRedisStreamCommand(commandName, args);
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
            commandName,
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
