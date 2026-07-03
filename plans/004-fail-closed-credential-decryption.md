# Plan 004: Credential decryption fails closed instead of returning ciphertext

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e1cb4079..HEAD -- packages/utils/src/encryption.ts`
> On any change, compare the "Current state" excerpt against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e1cb4079`, 2026-07-01

## Why this matters

`decryptTokenWithBackwardsCompatibility` catches _any_ decryption error and returns the raw stored value. When a value was genuinely encrypted but decryption fails — master key rotated, ciphertext corrupted, wrong key deployed — the function hands the ciphertext blob back as if it were a usable plaintext token, swallowing the misconfiguration. Callers (e.g. the GitHub access token at `packages/shared/src/model/user.ts:37`) then send a non-plaintext value downstream, and the operator gets no signal that decryption is broken. The intended backwards-compatibility case — values that were _never_ encrypted — must still pass through; only the "was encrypted, failed to decrypt" case should now throw.

## Current state

`packages/utils/src/encryption.ts:157-175`:

```ts
export function decryptTokenWithBackwardsCompatibility(
  token: string,
  encryptionKey: string,
): string {
  try {
    // First check if it looks like an encrypted value
    if (isValidBase64(token) && isEncrypted(token)) {
      return decryptValue(token, encryptionKey);
    }
    // If it doesn't look encrypted, return as-is (backwards compatibility)
    return token;
  } catch (error) {
    // If decryption fails for any reason, assume it's an unencrypted token
    console.warn("Failed to decrypt token, assuming it's unencrypted:", error);
    return token;
  }
}
```

Relevant helpers in the same file:

- `isEncrypted(value: string): boolean` — `encryption.ts:128` (exported).
- `isValidBase64(str: string): boolean` — `encryption.ts:140`.
- `decryptValue(...)` — throws on failure.

The bug: `decryptValue` is called only when `isEncrypted(token)` is already true, so if it throws, we know the value _was_ encrypted — yet the `catch` still returns the ciphertext.

## Commands you will need

| Purpose   | Command                                                                      | Expected on success |
| --------- | ---------------------------------------------------------------------------- | ------------------- |
| Typecheck | `pnpm tsc-check`                                                             | exit 0, no errors   |
| Test      | `pnpm -C packages/shared test` (see note) or the utils package's test runner | all pass            |

Note: determine the test runner for `packages/utils` — check `packages/utils/package.json` for a `test` script. If `packages/utils` has no test setup, place the test where existing `encryption` tests live (`grep -rln "decryptTokenWithBackwardsCompatibility\|encryption" packages/*/src --include="*.test.ts"`), and use that package's runner. STOP and report if no encryption test harness exists rather than inventing one.

## Scope

**In scope**:

- `packages/utils/src/encryption.ts`
- The existing encryption test file (extend it), or a new `encryption.test.ts` colocated with it if none exists

**Out of scope**:

- `isEncrypted`, `isValidBase64`, `decryptValue`, `encryptValue`, `encryptToken` — unchanged.
- All callers (`packages/shared/src/model/user.ts`, etc.) — the function's happy-path return type (`string`) is unchanged; callers that pass genuinely-encrypted, correctly-keyed values are unaffected. Do NOT add try/catch at call sites in this plan.

## Git workflow

- Branch: `advisor/004-decrypt-fail-closed`
- Commit message: `fix(encryption): fail closed when an encrypted token cannot be decrypted`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Only swallow the never-encrypted case

Rewrite the function so decryption failure on a value that _looks encrypted_ propagates, while a value that was never encrypted still passes through untouched:

```ts
export function decryptTokenWithBackwardsCompatibility(
  token: string,
  encryptionKey: string,
): string {
  // Values that were never encrypted (legacy plaintext) pass through unchanged.
  if (!(isValidBase64(token) && isEncrypted(token))) {
    return token;
  }
  // Looks encrypted: a failure here is a real misconfiguration (rotated/wrong
  // key, corrupted ciphertext). Do not mask it by returning the ciphertext.
  return decryptValue(token, encryptionKey);
}
```

Removing the `try/catch` lets `decryptValue`'s error propagate. Keep the exported signature identical.

**Verify**: `pnpm tsc-check` → exit 0.

### Step 2: Cover both branches with tests

See Test plan. Verify with the package's test runner → all pass.

## Test plan

Extend/create the encryption test file. Cases:

- **Round-trip**: `encryptToken(plaintext, key)` then `decryptTokenWithBackwardsCompatibility(cipher, key)` → returns `plaintext`.
- **Legacy plaintext passthrough**: a value that is not encrypted (e.g. a plain token that fails `isEncrypted`) → returned unchanged (no throw). Pick a value that `isEncrypted` returns false for; if a plausible plaintext happens to look base64+encrypted, that's fine — the point is the not-encrypted branch returns as-is.
- **Regression (the fix)**: an encrypted value decrypted with the _wrong_ key → the call **throws** (previously it silently returned the ciphertext). Encrypt with key A, decrypt with key B, assert it throws.

Model the test file on the existing encryption tests if present; otherwise mirror the structure of another `packages/utils` test.

Verification: package test runner → all pass including the 3 cases.

## Done criteria

- [ ] `pnpm tsc-check` exits 0
- [ ] `decryptTokenWithBackwardsCompatibility` no longer contains a `catch` that returns `token` (`grep -n "assuming it's unencrypted" packages/utils/src/encryption.ts` returns no match)
- [ ] A test proves wrong-key decryption of an encrypted value throws
- [ ] A test proves never-encrypted values still pass through
- [ ] Package tests pass
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- The function no longer matches the excerpt (drifted).
- `packages/utils` has no test harness and no existing encryption test exists anywhere — report so the operator can decide where tests live; do not stand up a new harness unprompted.
- You discover a caller that _depends on_ the fail-open behavior (i.e. deliberately passes ciphertext expecting the raw blob back) — grep callers of `decryptTokenWithBackwardsCompatibility`; if any treats a thrown error as unhandled on a hot path, STOP and report rather than letting it crash a request path.

## Maintenance notes

- Callers now surface a real error when the key is wrong. Before deploying, confirm the master key in the target environment matches what the stored ciphertext was encrypted with; a mismatch will now fail loudly (that is the point) — this is why Risk is MED.
- A reviewer should scan callers of this function for a place where a thrown error would take down an otherwise-recoverable request, and decide whether that specific caller wants a localized catch. Note: the GitHub OAuth token is also separately encrypted by better-auth (`apps/www/src/lib/auth.ts:315`), so this path is defense-in-depth.
- Deferred: adding length/entropy validation on `ENCRYPTION_MASTER_KEY` (finding SECURITY-06) is a separate plan.
