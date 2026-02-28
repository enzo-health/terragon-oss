import { readdirSync, statSync, readFileSync } from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { join, relative } from "path";

// Recursively find all page.tsx files
function findServerActionFiles(dir: string) {
  const files: string[] = [];
  const dirFiles = readdirSync(dir);
  for (const file of dirFiles) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && file !== "node_modules") {
      files.push(...findServerActionFiles(fullPath));
    } else {
      const fileContents = readFileSync(fullPath, "utf8");
      if (fileContents.includes("use server")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

describe("auth checks", async () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const adminDir = join(__dirname, "admin");
  const unauthedDir = join(__dirname, "unauthed");
  const adminServerActionFiles = findServerActionFiles(adminDir);
  const unauthedServerActionFiles = findServerActionFiles(unauthedDir);
  const nonAdminServerActionFiles = findServerActionFiles(__dirname).filter(
    (file) => {
      return (
        !adminServerActionFiles.includes(file) &&
        !unauthedServerActionFiles.includes(file)
      );
    },
  );

  for (const file of adminServerActionFiles) {
    const exports = await import(file);
    for (const key in exports) {
      if (!key.endsWith("Action")) {
        continue;
      }
      it(`should wrap all exports in ${relative(adminDir, file)} -> ${key} with adminOnly`, async () => {
        const fn = exports[key as keyof typeof exports];
        expect(fn.adminOnly).toBe(true);
      });
    }
  }

  for (const file of nonAdminServerActionFiles) {
    const exports = await import(file);
    for (const key in exports) {
      if (!key.endsWith("Action")) {
        continue;
      }
      it(`should wrap all exports in ${relative(__dirname, file)} -> ${key} with userOnlyAction`, async () => {
        const fn = exports[key as keyof typeof exports];
        expect(fn.userOnly).toBe(true);
        expect(fn.wrappedServerAction).toBe(true);
      });
    }
  }
  // TODO: Get this to pass, then update the above to check for wrappedServerAction too.
  it.skip("should wrap all server actions with adminOnlyAction or userOnlyAction", async () => {
    let totalExports = 0;
    let wrappedExports = 0;
    for (const file of [
      ...adminServerActionFiles,
      ...nonAdminServerActionFiles,
    ]) {
      const exports = await import(file);
      for (const key in exports) {
        const fn = exports[key as keyof typeof exports];
        totalExports++;
        if (fn.wrappedServerAction) {
          wrappedExports++;
        }
      }
    }
    expect(wrappedExports).toBe(totalExports);
  });

  const allServerActionFiles = new Set(
    findServerActionFiles(join(__dirname, "..")),
  );
  const allServerActionFilesChecked = new Set([
    ...adminServerActionFiles,
    ...nonAdminServerActionFiles,
    ...unauthedServerActionFiles,
  ]);
  it("All server actions should be in __dirname", async () => {
    for (const file of allServerActionFiles) {
      console.log(file);
      expect(allServerActionFilesChecked.has(file)).toBe(true);
    }
  });
});
