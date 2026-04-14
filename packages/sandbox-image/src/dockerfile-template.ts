/**
 * Dockerfile template content as a TypeScript string.
 *
 * This is the canonical source for bundled environments (Next.js serverless).
 * The Handlebars file at ../Dockerfile.hbs is used by local scripts
 * (create-template.ts, update-dockerfile-versions.ts) that run via tsx.
 *
 * IMPORTANT: Keep in sync with ../Dockerfile.hbs — if you update one, update the other.
 */
export const DOCKERFILE_TEMPLATE = `# Use Ubuntu as the base image
# Note: Use \`FROM e2bdev/code-interpreter:latest\` instead if you want to use the code interpreting features (https://github.com/e2b-dev/code-interpreter)
# and not just plain E2B sandbox.
FROM ubuntu:24.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Set environment variables that don't change filesystem
ENV BUN_INSTALL="/root/.bun" \\
    PATH="/root/.bun/bin:/usr/local/bin:$PATH"

# Combine all apt operations, repository setup, and tool installations into one layer
RUN apt-get update && apt-get install -y \\
    apt-transport-https \\
    ca-certificates \\
    curl \\
    gnupg \\
    lsb-release \\
    gcc \\
    python3 \\
    python3-pip \\
    unzip \\
    software-properties-common \\
    jq \\
    ripgrep \\
    supervisor \\
    postgresql \\
    redis-server \\
    bubblewrap \\
    && rm -rf /var/lib/apt/lists/*

# Configure PostgreSQL for passwordless local dev access
RUN printf 'local all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n' > /etc/postgresql/16/main/pg_hba.conf \\
    && sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" /etc/postgresql/16/main/postgresql.conf

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && apt-get install -y nodejs \\
    && apt-get clean \\
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \\
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
    && apt-get update \\
    && apt-get install -y --no-install-recommends gh \\
    && apt-get clean \\
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash \\
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install pnpm, sandbox-agent, claude code, gemini cli, amp, codex, and opencode
RUN npm install -g pnpm \\
    @anthropic-ai/claude-code@2.1.52 \\
    @google/gemini-cli@0.29.7 \\
    @sourcegraph/amp@0.0.1771963583-ga618c9 \\
    @openai/codex@0.116.0 \\
    opencode-ai@1.2.10 \\
    @sandbox-agent/cli@0.2.1


# Patch gemini cli to disable console.debug
RUN sed -i.bak -e '1a\\
console.debug = () => {};' "$(readlink -f "$(which gemini)")"

# Patch claude code
RUN sed -i.bak -e '1a\\
Object.defineProperty(process, "getuid", {\\
  value: function() { return 1000; },\\
  writable: false,\\
  enumerable: true,\\
  configurable: true\\
});' -e 's/![a-zA-Z_$][a-zA-Z0-9_$]*()[.]bypassPermissionsModeAccepted/false/g' "$(readlink -f "$(which claude)")"

{{#if (eq sandboxProvider "daytona")}}
# Start Supervisor in the foreground (PID 1)
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
RUN mkdir -p /var/run /var/log/supervisor
ENTRYPOINT ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
{{/if}}
`;
