import { customAlphabet } from "nanoid/non-secure";

export const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789");

export function generateRandomBranchSuffix(): string {
  return nanoid(6).toLowerCase();
}

export function generateRandomBranchName(prefix = "leo/"): string {
  // Do not mutate the provided prefix; use it as-is
  const uniqueSuffix = generateRandomBranchSuffix();
  return `${prefix}${uniqueSuffix}`;
}

export const diffCutoff = 200000;

/**
 * Wraps a string in single quotes and escapes any single quotes within it for safe bash usage.
 *
 * @example
 * bashQuote("O'Brien") // Returns: 'O'"'"'Brien'
 * bashQuote("simple") // Returns: 'simple'
 */
export function bashQuote(str: string): string {
  return `'${str.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Sanitizes a string to be a valid environment variable name.
 * Replaces any character that isn't alphanumeric or underscore with an underscore.
 * Ensures the result starts with a letter or underscore (not a number).
 *
 * @example
 * safeEnvKey("my-var") // Returns: "my_var"
 * safeEnvKey("123var") // Returns: "_123var"
 * safeEnvKey("my.var!") // Returns: "my_var_"
 */
export function safeEnvKey(key: string): string {
  // Replace invalid characters with underscores
  let safe = key.replace(/[^a-zA-Z0-9_]/g, "_");
  // Ensure it doesn't start with a number
  if (/^[0-9]/.test(safe)) {
    safe = "_" + safe;
  }
  // Ensure it's not empty
  if (safe.length === 0) {
    safe = "_";
  }
  if (safe !== key) {
    console.warn(`Sanitized environment variable key: ${key} -> ${safe}`);
  }
  return safe;
}
