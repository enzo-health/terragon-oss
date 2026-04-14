import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFrontmatter,
  isFrontmatterValid,
  sanitizeRepoSkillFiles,
} from "./sanitize-skills";

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

describe("extractFrontmatter", () => {
  it("returns frontmatter content between --- delimiters", () => {
    const content = '---\nname: "test"\ndescription: A skill\n---\n# Body';
    expect(extractFrontmatter(content)).toBe(
      'name: "test"\ndescription: A skill',
    );
  });

  it("returns null when no frontmatter block exists", () => {
    expect(extractFrontmatter("# Just a heading\nSome content")).toBeNull();
  });

  it("handles frontmatter at end of file without trailing newline", () => {
    const content = "---\nname: test\n---";
    expect(extractFrontmatter(content)).toBe("name: test");
  });

  it("returns null for unclosed frontmatter", () => {
    expect(extractFrontmatter("---\nname: test\nno closing")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const content = '---\r\nname: "test"\r\n---\r\n# Body';
    expect(extractFrontmatter(content)).toBe('name: "test"');
  });

  it("rejects ---- (four dashes) as frontmatter delimiter", () => {
    expect(extractFrontmatter("----\nname: test\n---\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isFrontmatterValid
// ---------------------------------------------------------------------------

describe("isFrontmatterValid", () => {
  it("accepts valid key-value frontmatter", () => {
    expect(
      isFrontmatterValid('name: "My Skill"\ndescription: A description'),
    ).toBe(true);
  });

  it("accepts quoted values with colons", () => {
    expect(isFrontmatterValid('description: "Some text: with a colon"')).toBe(
      true,
    );
  });

  it("accepts single-quoted values with colons", () => {
    expect(isFrontmatterValid("description: 'Some text: with a colon'")).toBe(
      true,
    );
  });

  it("rejects unquoted values containing colons", () => {
    expect(isFrontmatterValid("description: Some text: with a colon")).toBe(
      false,
    );
  });

  it("accepts empty values", () => {
    expect(isFrontmatterValid("name:\ndescription: test")).toBe(true);
  });

  it("accepts block scalar indicators", () => {
    expect(isFrontmatterValid("description: |\n  multi\n  line")).toBe(true);
    expect(isFrontmatterValid("description: >\n  folded")).toBe(true);
  });

  it("accepts comments and blank lines", () => {
    expect(
      isFrontmatterValid("# comment\nname: test\n\ndescription: foo"),
    ).toBe(true);
  });

  it("accepts list items", () => {
    expect(isFrontmatterValid("tags:\n- one\n- two")).toBe(true);
  });

  it("accepts URLs with colons as valid plain scalars", () => {
    expect(isFrontmatterValid("url: https://example.com/path")).toBe(true);
    expect(isFrontmatterValid("repo: git@github.com:org/repo.git")).toBe(true);
  });

  it("accepts timestamps with colons as valid plain scalars", () => {
    expect(isFrontmatterValid("created: 2026-03-18T01:00:00Z")).toBe(true);
  });

  it("rejects colon-space in unquoted values (YAML mapping indicator)", () => {
    expect(isFrontmatterValid("description: Some text: with a colon")).toBe(
      false,
    );
  });

  it("rejects unbalanced double quotes", () => {
    expect(isFrontmatterValid('name: "unclosed')).toBe(false);
  });

  it("rejects unbalanced single quotes", () => {
    expect(isFrontmatterValid("name: 'unclosed")).toBe(false);
  });

  it("accepts array and object values", () => {
    expect(isFrontmatterValid("tags: [a, b, c]")).toBe(true);
    expect(isFrontmatterValid("meta: {key: val}")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRepoSkillFiles
// ---------------------------------------------------------------------------

describe("sanitizeRepoSkillFiles", () => {
  let tmpDir: string;
  let originalCwd: string;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sanitize-skills-")),
    );
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when .claude/skills does not exist", () => {
    sanitizeRepoSkillFiles(logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("leaves valid skill files untouched", () => {
    const skillDir = path.join(tmpDir, ".claude", "skills", "planner");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      '---\nname: "planner"\ndescription: "Plans things"\n---\n# Planner',
    );

    sanitizeRepoSkillFiles(logger);

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(`${skillPath}.disabled`)).toBe(false);
  });

  it("renames skill files with invalid YAML frontmatter", () => {
    const skillDir = path.join(tmpDir, ".claude", "skills", "planner");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      "---\ndescription: Some text: with unquoted colon\n---\n# Broken",
    );

    sanitizeRepoSkillFiles(logger);

    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(`${skillPath}.disabled`)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Disabled skill file with invalid YAML frontmatter",
      expect.objectContaining({ original: skillPath }),
    );
  });

  it("handles nested skill directories", () => {
    const nested = path.join(tmpDir, ".claude", "skills", "deep", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const validPath = path.join(nested, "good.md");
    const invalidPath = path.join(nested, "bad.md");
    fs.writeFileSync(validPath, '---\nname: "good"\n---\nContent');
    fs.writeFileSync(invalidPath, "---\ntitle: bad: yaml: here\n---\nContent");

    sanitizeRepoSkillFiles(logger);

    expect(fs.existsSync(validPath)).toBe(true);
    expect(fs.existsSync(invalidPath)).toBe(false);
    expect(fs.existsSync(`${invalidPath}.disabled`)).toBe(true);
  });

  it("leaves files without frontmatter alone", () => {
    const skillDir = path.join(tmpDir, ".claude", "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    const noFmPath = path.join(skillDir, "readme.md");
    fs.writeFileSync(noFmPath, "# Just a readme\nNo frontmatter here.");

    sanitizeRepoSkillFiles(logger);

    expect(fs.existsSync(noFmPath)).toBe(true);
  });
});
