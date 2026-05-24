import {
  getJsonPointerPathField,
  getStringField,
} from "./renderable-part-shape";

type JsonPatchOperation =
  | {
      op: "add" | "replace";
      path: string;
      value: unknown;
    }
  | {
      op: "remove";
      path: string;
    };

export function applyJsonPatchOperations(
  root: Record<string, unknown>,
  operations: unknown[],
): Record<string, unknown> | null {
  let next: unknown = { ...root };
  for (const operation of operations) {
    const patchOperation = parseJsonPatchOperation(operation);
    if (!patchOperation) {
      return null;
    }
    next = applyJsonPatchOperation(next, patchOperation);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return null;
    }
  }
  return getRecordValue(next);
}

function parseJsonPatchOperation(value: unknown): JsonPatchOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const op = getStringField(value, "op");
  const path = getJsonPointerPathField(value);
  if (!op || path === null) {
    return null;
  }
  if (op === "remove") {
    return { op, path };
  }
  if (op === "add" || op === "replace") {
    return { op, path, value: Reflect.get(value, "value") };
  }
  return null;
}

function applyJsonPatchOperation(
  root: unknown,
  operation: JsonPatchOperation,
): unknown | null {
  if (operation.path === "") {
    if (operation.op === "remove") {
      return {};
    }
    return getRecordValue(operation.value);
  }

  const tokens = parseJsonPointer(operation.path);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  const clone = cloneContainer(root);
  if (!clone) {
    return null;
  }
  let cursor: unknown = clone;
  for (const token of tokens.slice(0, -1)) {
    const child = getContainerChild(cursor, token);
    const clonedChild = cloneContainer(child);
    if (!clonedChild || !setContainerChild(cursor, token, clonedChild)) {
      return null;
    }
    cursor = clonedChild;
  }
  const finalToken = tokens[tokens.length - 1]!;
  if (operation.op === "remove") {
    return removeContainerChild(cursor, finalToken) ? clone : null;
  }
  return setContainerChild(cursor, finalToken, operation.value, operation.op)
    ? clone
    : null;
}

function parseJsonPointer(path: string): string[] | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const tokens = path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  return tokens.every(isSafeJsonPointerToken) ? tokens : null;
}

function isSafeJsonPointerToken(token: string): boolean {
  return (
    token !== "__proto__" && token !== "constructor" && token !== "prototype"
  );
}

function cloneContainer(
  value: unknown,
): Record<string, unknown> | unknown[] | null {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value));
  }
  return null;
}

function getContainerChild(container: unknown, token: string): unknown {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, false);
    return index === null ? undefined : container[index];
  }
  if (container && typeof container === "object") {
    return Object.hasOwn(container, token)
      ? Reflect.get(container, token)
      : undefined;
  }
  return undefined;
}

function setContainerChild(
  container: unknown,
  token: string,
  value: unknown,
  op: "add" | "replace" = "replace",
): boolean {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, op === "add");
    if (index === null) {
      return false;
    }
    if (op === "add") {
      container.splice(index, 0, value);
      return true;
    }
    if (index >= container.length) {
      return false;
    }
    container[index] = value;
    return true;
  }
  if (container && typeof container === "object") {
    if (op === "replace" && !Object.hasOwn(container, token)) {
      return false;
    }
    return Reflect.set(container, token, value);
  }
  return false;
}

function removeContainerChild(container: unknown, token: string): boolean {
  if (Array.isArray(container)) {
    const index = parseArrayIndex(token, container.length, false);
    if (index === null || index >= container.length) {
      return false;
    }
    container.splice(index, 1);
    return true;
  }
  if (container && typeof container === "object") {
    if (!Object.hasOwn(container, token)) {
      return false;
    }
    return Reflect.deleteProperty(container, token);
  }
  return false;
}

function parseArrayIndex(
  token: string,
  length: number,
  allowAppend: boolean,
): number | null {
  if (allowAppend && token === "-") {
    return length;
  }
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    return null;
  }
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    return null;
  }
  return index;
}

function getRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
