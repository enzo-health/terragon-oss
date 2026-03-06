/**
 * Returns raw Dockerfile commands (for Image.dockerfileCommands()) that replicate
 * Dockerfile.daytona exactly, starting after the FROM instruction.
 *
 * Usage in snapshot-builder:
 *   import { Image } from "@daytonaio/sdk";
 *   import { getDaytonaBaseCommands } from "@terragon/sandbox-image";
 *   const image = Image.base("ubuntu:24.04").dockerfileCommands(getDaytonaBaseCommands());
 *
 * Why this exists:
 *   Daytona template snapshots live in cr.app.daytona.io/sbox/ (private registry).
 *   Docker build workers cannot pull from that registry with personal API keys, so
 *   Image.base(template_ref) fails with "unauthorized". Building from ubuntu:24.04
 *   (public) avoids this entirely. Docker layer caching on Daytona's build workers
 *   means the base layers are fast after the first build.
 */
export function getDaytonaBaseCommands(): string[] {
  return [
    "ENV DEBIAN_FRONTEND=noninteractive",
    'ENV BUN_INSTALL="/root/.bun" PATH="/root/.bun/bin:/usr/local/bin:$PATH"',

    // System packages
    "RUN apt-get update && apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release gcc python3 python3-pip unzip software-properties-common jq ripgrep supervisor postgresql redis-server && rm -rf /var/lib/apt/lists/*",

    // PostgreSQL: passwordless local dev access
    "RUN printf 'local all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n' > /etc/postgresql/16/main/pg_hba.conf && sed -i \"s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/\" /etc/postgresql/16/main/postgresql.conf",

    // Node.js 22
    "RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && apt-get clean && rm -rf /var/lib/apt/lists/*",

    // GitHub CLI
    'RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update && apt-get install -y --no-install-recommends gh && apt-get clean && rm -rf /var/lib/apt/lists/*',

    // bun
    "RUN curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun",

    // npm global packages (pinned versions — keep in sync with Dockerfile.daytona)
    "RUN npm install -g pnpm @anthropic-ai/claude-code@2.1.70 @google/gemini-cli@0.32.1 @sourcegraph/amp@0.0.1772802427-gaf6d64 @openai/codex@0.111.0 opencode-ai@1.2.20 @sandbox-agent/cli@0.2.1",

    // Codex config (replaces heredoc)
    "RUN mkdir -p /root/.codex && printf '[model_providers.openai]\\nname = \"openai\"\\nstream_idle_timeout_ms = 600000\\nstream_max_retries = 20\\n' > /root/.codex/config.toml",

    // Patch gemini cli: disable console.debug output
    // Dockerfile equivalent: RUN sed -i.bak -e '1a\↵console.debug = () => {};' "$(readlink -f "$(which gemini)")"
    // (Dockerfile line continuation collapses to: '1a\console.debug...' — GNU sed a command)
    'RUN sed -i.bak -e \'1a\\console.debug = () => {};\' "$(readlink -f "$(which gemini)")"\n',

    // Patch claude code: fake getuid() to pass root check + allow bypassPermissionsModeAccepted
    'RUN sed -i.bak -e \'1a\\Object.defineProperty(process, "getuid", {  value: function() { return 1000; },  writable: false,  enumerable: true,  configurable: true});\' -e \'s/![a-zA-Z_$][a-zA-Z0-9_$]*()[.]bypassPermissionsModeAccepted/false/g\' "$(readlink -f "$(which claude)")"\n',

    // Supervisord config — inline write replaces COPY supervisord.conf
    "RUN mkdir -p /etc/supervisor/conf.d /var/run /var/log/supervisor && printf '[supervisord]\\nnodaemon=true\\nlogfile=/dev/null\\npidfile=/var/run/supervisord.pid\\n\\n[program:postgresql]\\ncommand=/usr/bin/pg_ctlcluster 16 main start --foreground\\nuser=postgres\\npriority=10\\nautostart=true\\nautorestart=true\\nstdout_logfile=/dev/fd/1\\nstderr_logfile=/dev/fd/2\\nstdout_logfile_maxbytes=0\\nstderr_logfile_maxbytes=0\\n\\n[program:redis]\\ncommand=/usr/bin/redis-server --bind 127.0.0.1 --protected-mode yes --daemonize no\\npriority=20\\nautostart=true\\nautorestart=true\\nstdout_logfile=/dev/fd/1\\nstderr_logfile=/dev/fd/2\\nstdout_logfile_maxbytes=0\\nstderr_logfile_maxbytes=0\\n' > /etc/supervisor/conf.d/supervisord.conf",
  ];
}
