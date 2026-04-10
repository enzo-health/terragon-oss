import { describe, beforeAll, it, afterAll } from "vitest";
import type { ISandboxSession } from "@leo/sandbox/types";
import { bashQuote } from "@leo/sandbox/utils";
import type { SandboxProvider, SandboxSize } from "@leo/types/sandbox";
import { getOrCreateSandbox, hibernateSandbox } from "@leo/sandbox";

const timeoutMs = 5 * 60 * 1000;

describe.concurrent(
  "sandbox image tests",
  { skip: !process.env.SANDBOX_IMAGE_TEST, timeout: timeoutMs },
  () => {
    // Instead of using describe.each, we use describe.concurrent to run the tests in parallel
    // and allow us to .only on specific suites and tests.
    describe("e2b / small", () => testSuite("e2b", "small"));
    describe("e2b / large", () => testSuite("e2b", "large"));
    // Daytona tests are skipped - not used in production
    describe.skip("daytona / small", () => testSuite("daytona", "small"));
    describe.skip("daytona / large", () => testSuite("daytona", "large"));
  },
);

function testSuite(provider: SandboxProvider, size: SandboxSize) {
  let sandbox: ISandboxSession;
  beforeAll(async () => {
    sandbox = await getOrCreateSandbox(null /* sandboxId */, {
      sandboxProvider: provider,
      sandboxSize: size,
      threadName: null,
      agent: null,
      agentCredentials: null,
      userName: "test-user",
      userEmail: "test@example.com",
      githubAccessToken: "test-token",
      githubRepoFullName: "SawyerHood/test-project",
      repoBaseBranchName: "main",
      userId: "test-user-id",
      createNewBranch: false,
      environmentVariables: [],
      autoUpdateDaemon: false,
      publicUrl: "http://localhost:3000",
      featureFlags: {},
      generateBranchName: async () => null,
      onStatusUpdate: async ({ sandboxId, sandboxStatus, bootingStatus }) => {
        console.log({
          provider,
          size,
          sandboxId,
          sandboxStatus,
          bootingStatus,
        });
      },
    });
  }, timeoutMs);

  afterAll(async () => {
    await hibernateSandbox({
      sandboxProvider: provider,
      sandboxId: sandbox.sandboxId,
    });
  }, 60 * 1000);

  it("should have an expected entrypoint", async ({ expect }) => {
    const entrypoint = await sandbox.runCommand("ps -p 1 -o args=", {
      cwd: ".",
    });
    expect(entrypoint.trim()).toMatchSnapshot();
  });

  it("should have gh cli installed", async ({ expect }) => {
    const output = await sandbox.runCommand("gh --version", { cwd: "." });
    expect(output.trim()).toMatchSnapshot();
    const output2 = await sandbox.runCommand("which gh", { cwd: "." });
    expect(output2).toContain("/gh");
  });

  describe("agents", () => {
    it("should have claude cli installed and working", async ({ expect }) => {
      // Check claude is installed
      const version = await sandbox.runCommand("claude --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
      // Check claude location
      const which = await sandbox.runCommand("which claude", { cwd: "." });
      expect(which).toMatch(/claude/gi);
    });

    it("should have codex cli installed and working", async ({ expect }) => {
      const version = await sandbox.runCommand("codex --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
      const which = await sandbox.runCommand("which codex", { cwd: "." });
      expect(which).toMatch(/codex/gi);
    });

    it("should have amp cli installed", async ({ expect }) => {
      const version = await sandbox.runCommand("amp --version", {
        cwd: ".",
      });
      // Match version format like "0.0.1765471542-g74e231 (released ...)"
      // Using regex to avoid flaky tests due to "X ago" changing over time
      expect(version.trim()).toMatch(/^0\.0\.\d+-g[a-f0-9]+ \(released /);
      const which = await sandbox.runCommand("which amp", { cwd: "." });
      expect(which).toContain("/amp");
    });

    it("should have the opencode cli installed", async ({ expect }) => {
      const version = await sandbox.runCommand("opencode --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
      const which = await sandbox.runCommand("which opencode", { cwd: "." });
      expect(which).toContain("/opencode");
    });

    it("should have gemini cli installed and working", async ({ expect }) => {
      const version = await sandbox.runCommand("gemini --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
      const which = await sandbox.runCommand("which gemini", { cwd: "." });
      expect(which).toContain("/gemini");
    });
  });

  describe("language & runtime support", () => {
    it("node & npm", async ({ expect }) => {
      // Check node is available
      const node = await sandbox.runCommand("node --version", { cwd: "." });
      expect(node.trim()).toMatchSnapshot();
    });

    it("npm", async ({ expect }) => {
      // Check npm is available
      const npm = await sandbox.runCommand("npm --version", { cwd: "." });
      expect(npm.trim()).toMatchSnapshot();
    });

    it("bun", async ({ expect }) => {
      // Check bun is installed
      const version = await sandbox.runCommand("bun --version", { cwd: "." });
      expect(version.trim()).toMatchSnapshot();

      // Check bun location
      const which = await sandbox.runCommand("which bun", { cwd: "." });
      expect(which).toContain("/bun");

      // Test bun can install packages
      await sandbox.runCommand(
        'mkdir -p /tmp/bun-test && cd /tmp/bun-test && echo \'{"name": "bun-test", "version": "1.0.0"}\' > package.json',
        { cwd: "." },
      );
      const install = await sandbox.runCommand(
        "cd /tmp/bun-test && bun add lodash",
        { cwd: "." },
      );
      expect(install).toContain("lodash");

      // Verify package was installed
      const check = await sandbox.runCommand(
        "cd /tmp/bun-test && ls node_modules/lodash/package.json",
        { cwd: "." },
      );
      expect(check).toContain("package.json");

      // Cleanup
      await sandbox.runCommand("rm -rf /tmp/bun-test", { cwd: "." });
    });

    it("pnpm", async ({ expect }) => {
      // Check pnpm is installed
      const version = await sandbox.runCommand("pnpm --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();

      // Check pnpm location
      const which = await sandbox.runCommand("which pnpm", { cwd: "." });
      expect(which).toContain("/pnpm");

      // Test pnpm can install packages
      await sandbox.runCommand(
        'mkdir -p /tmp/pnpm-test && cd /tmp/pnpm-test && echo \'{"name": "pnpm-test", "version": "1.0.0"}\' > package.json',
        { cwd: "." },
      );
      const install = await sandbox.runCommand(
        "cd /tmp/pnpm-test && pnpm add axios",
        { cwd: "." },
      );
      expect(install).toContain("axios");

      // Verify lockfile was created
      const check = await sandbox.runCommand(
        "cd /tmp/pnpm-test && ls pnpm-lock.yaml",
        { cwd: "." },
      );
      expect(check).toContain("pnpm-lock.yaml");

      // Cleanup
      await sandbox.runCommand("rm -rf /tmp/pnpm-test", { cwd: "." });
    });

    it("python3", async ({ expect }) => {
      // Check python is installed
      const version = await sandbox.runCommand("python3 --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
    });

    it("docker", async ({ expect }) => {
      // Check docker is installed
      const version = await sandbox.runCommand("docker --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
      // Run a simple docker command to make sure docker works
      const output = await sandbox.runCommand("docker ps", {
        cwd: ".",
      });
      expect(output.trim()).toMatchSnapshot();
    });

    it("docker compose", async ({ expect }) => {
      // Check docker compose is installed
      const version = await sandbox.runCommand("docker compose version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
    });

    it("gcc", async ({ expect }) => {
      // Check gcc is installed
      const version = await sandbox.runCommand("gcc --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
    });

    it("rust", async ({ expect }) => {
      // Check rust is installed
      const version = await sandbox.runCommand("rustc --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
    });

    it("cargo", async ({ expect }) => {
      // Check cargo is installed
      const version = await sandbox.runCommand("cargo --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();
    });

    it("php", async ({ expect }) => {
      // Check PHP is installed
      const version = await sandbox.runCommand("php --version", {
        cwd: ".",
      });
      expect(version.trim()).toMatchSnapshot();

      // Check PHP extensions
      const extensions = await sandbox.runCommand("php -m", { cwd: "." });
      expect(extensions.trim()).toMatchSnapshot();

      // Test PHP script execution
      const phpScript = await sandbox.runCommand(
        'echo "<?php echo \\"Hello from PHP!\\\\n\\"; ?>" > /tmp/test.php && php /tmp/test.php',
        { cwd: "." },
      );
      expect(phpScript.trim()).toMatchSnapshot();

      // Cleanup
      await sandbox.runCommand("rm -f /tmp/test.php", { cwd: "." });
    });

    it("composer", async ({ expect }) => {
      // Check Composer is installed
      const version = await sandbox.runCommand("composer --version", {
        cwd: ".",
      });
      expect(version).toContain("Composer");
      expect(version).toContain("version");

      // Check Composer location
      const which = await sandbox.runCommand("which composer", { cwd: "." });
      expect(which).toContain("/composer");

      // Test Composer functionality
      await sandbox.runCommand(
        "mkdir -p /tmp/composer-test && cd /tmp/composer-test",
        { cwd: "." },
      );

      // Create a simple composer.json
      const init = await sandbox.runCommand(
        "cd /tmp/composer-test && composer init --no-interaction --name=test/project --description='Test project' --author='Test Author <test@example.com>' 2>&1",
        { cwd: "." },
      );
      // Composer outputs to stderr when running as root, so we redirect stderr to stdout
      expect(init).toContain("Writing ./composer.json");

      // Verify composer.json was created
      const verify = await sandbox.runCommand(
        "cd /tmp/composer-test && composer validate 2>&1",
        { cwd: "." },
      );
      expect(verify).toContain("valid");

      // Install a package
      const install = await sandbox.runCommand(
        "cd /tmp/composer-test && composer require monolog/monolog 2>&1",
        { cwd: "." },
      );
      expect(install).toContain("monolog/monolog");

      // Verify vendor directory was created
      const vendor = await sandbox.runCommand(
        "cd /tmp/composer-test && ls -la vendor/monolog",
        { cwd: "." },
      );
      expect(vendor).toContain("monolog");

      // Cleanup
      await sandbox.runCommand("rm -rf /tmp/composer-test", { cwd: "." });
    });

    it.todo("ruby");
    it.todo("go");
    it.todo("java");
    it.todo("kotlin");
    it.todo("scala");
  });

  describe("package manager integration", () => {
    it("should handle multiple package managers in the same project", async ({
      expect,
    }) => {
      // Create a test project
      await sandbox.runCommand(
        'mkdir -p /tmp/multi-pm-test && cd /tmp/multi-pm-test && echo \'{"name": "multi-pm-test", "version": "1.0.0"}\' > package.json',
        { cwd: "." },
      );

      // Install with bun
      const bunInstall = await sandbox.runCommand(
        "cd /tmp/multi-pm-test && bun add lodash",
        { cwd: "." },
      );
      expect(bunInstall).toContain("lodash");

      // Install with pnpm (should work alongside bun)
      const pnpmInstall = await sandbox.runCommand(
        "cd /tmp/multi-pm-test && pnpm add axios",
        { cwd: "." },
      );
      expect(pnpmInstall).toContain("axios");

      // Verify both lockfiles exist
      const files = await sandbox.runCommand(
        "cd /tmp/multi-pm-test && ls -la | grep -E '(bun.lockb|pnpm-lock.yaml)'",
        { cwd: "." },
      );
      expect(files).toContain("pnpm-lock.yaml");

      // Cleanup
      await sandbox.runCommand("rm -rf /tmp/multi-pm-test", { cwd: "." });
    });
  });

  describe("bash support", () => {
    it("should source .bashrc when running a login shell", async ({
      expect,
    }) => {
      const testBinaryPath = "/tmp/test-binary";
      const testBinary = "echo 'Hello from test binary!'";
      await sandbox.runCommand(
        [
          `echo ${bashQuote(`#!/bin/bash\n${testBinary}`)} > ${testBinaryPath}`,
          `chmod +x ${testBinaryPath}`,
          `echo 'export PATH=\$PATH:/tmp' >> ~/.bashrc`,
        ].join(" && "),
        { cwd: "." },
      );
      const output = await sandbox.runCommand("bash -lc 'test-binary'", {
        cwd: ".",
      });
      expect(output.trim()).toMatchSnapshot();
    });
  });
}
