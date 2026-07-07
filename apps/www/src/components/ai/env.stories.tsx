import type { Story, StoryDefault } from "@ladle/react";
import {
  Env,
  EnvHeader,
  EnvList,
  EnvTitle,
  EnvVar,
  EnvVarCopy,
  EnvVarName,
  EnvVarValue,
  useEnv,
} from "./env";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const CopyIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="size-3.5"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

const Copy = () => (
  <EnvVarCopy className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/env-var:opacity-100 data-copied:opacity-100">
    <CopyIcon />
  </EnvVarCopy>
);

const RevealToggle = () => {
  const { visible, setVisible } = useEnv();
  return (
    <button
      type="button"
      onClick={() => setVisible(!visible)}
      className="ml-auto rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {visible ? "Hide values" : "Reveal values"}
    </button>
  );
};

type Row = { name: string; value: string; secret?: boolean };

const ROWS: Row[] = [
  { name: "NODE_ENV", value: "production" },
  { name: "NEXT_PUBLIC_APP_URL", value: "https://app.terragon.dev" },
  {
    name: "DATABASE_URL",
    value: "postgresql://postgres:postgres@db:5432/postgres",
    secret: true,
  },
  {
    name: "ANTHROPIC_API_KEY",
    value: "sk-ant-api03-8f3a1c2b7d04",
    secret: true,
  },
  {
    name: "E2B_API_KEY",
    value: "e2b_9f3a1c2b7d0411ff9e5x9k2mQ8vJ",
    secret: true,
  },
  { name: "REDIS_URL", value: "redis://redis:6379" },
];

function Rows({ rows }: { rows: Row[] }) {
  return (
    <EnvList>
      {rows.map((row) => (
        <EnvVar key={row.name} value={row.value} secret={row.secret}>
          <EnvVarName>{row.name}</EnvVarName>
          <EnvVarValue />
          <Copy />
        </EnvVar>
      ))}
    </EnvList>
  );
}

export const Masked: Story = () => (
  <Surface>
    <Env>
      <EnvHeader>
        <EnvTitle>Environment</EnvTitle>
        <RevealToggle />
      </EnvHeader>
      <Rows rows={ROWS} />
    </Env>
  </Surface>
);

export const Revealed: Story = () => (
  <Surface>
    <Env defaultVisible>
      <EnvHeader>
        <EnvTitle>Environment</EnvTitle>
        <RevealToggle />
      </EnvHeader>
      <Rows rows={ROWS} />
    </Env>
  </Surface>
);

export const NoSecrets: Story = () => (
  <Surface>
    <Env>
      <EnvHeader>
        <EnvTitle>Environment</EnvTitle>
      </EnvHeader>
      <Rows rows={ROWS.filter((row) => !row.secret)} />
    </Env>
  </Surface>
);

export const LongValueOverflow: Story = () => (
  <Surface>
    <Env defaultVisible>
      <EnvHeader>
        <EnvTitle>Environment</EnvTitle>
        <RevealToggle />
      </EnvHeader>
      <EnvList>
        <EnvVar value="postgresql://postgres:postgres@db.internal.terragon.dev:5432/postgres?sslmode=require&application_name=agent-daemon&connect_timeout=30">
          <EnvVarName>DATABASE_URL</EnvVarName>
          <EnvVarValue />
          <Copy />
        </EnvVar>
        <EnvVar
          secret
          value="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzViOWsybVE4dkoiLCJvcmciOiJvcmdfNXg5azJtUTh2SiJ9.8f3a1c2b7d0411ff9e"
        >
          <EnvVarName>SESSION_TOKEN</EnvVarName>
          <EnvVarValue />
          <Copy />
        </EnvVar>
      </EnvList>
    </Env>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <Env>
      <EnvHeader>
        <EnvTitle>Environment</EnvTitle>
      </EnvHeader>
      <EnvList className="px-4 py-3 text-sm text-muted-foreground">
        No environment variables configured.
      </EnvList>
    </Env>
  </Surface>
);

export default {
  title: "ai/env",
} satisfies StoryDefault;
