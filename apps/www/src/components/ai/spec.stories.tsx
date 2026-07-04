import type { Story, StoryDefault } from "@ladle/react";
import {
  Spec,
  SpecContent,
  SpecField,
  SpecFieldLabel,
  SpecFieldValue,
  SpecHeader,
  SpecItem,
  SpecTrigger,
} from "./spec";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-xs">{children}</span>
);

export const Collapsed: Story = () => (
  <Surface>
    <Spec>
      <SpecHeader>
        <div>Setting</div>
        <div>Value</div>
      </SpecHeader>
      <SpecItem>
        <SpecTrigger>
          <div>Model</div>
          <div className="text-muted-foreground">
            <Mono>claude-opus-4-8[1m]</Mono>
          </div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Provider</SpecFieldLabel>
            <SpecFieldValue>Anthropic</SpecFieldValue>
          </SpecField>
          <SpecField>
            <SpecFieldLabel>Context window</SpecFieldLabel>
            <SpecFieldValue>1,000,000 tokens</SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
      <SpecItem>
        <SpecTrigger>
          <div>Sandbox</div>
          <div className="text-muted-foreground">E2B</div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Template</SpecFieldLabel>
            <SpecFieldValue>
              <Mono>terragon/sandbox-image:latest</Mono>
            </SpecFieldValue>
          </SpecField>
          <SpecField>
            <SpecFieldLabel>Region</SpecFieldLabel>
            <SpecFieldValue>us-east-1</SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
    </Spec>
  </Surface>
);

export const Expanded: Story = () => (
  <Surface>
    <Spec>
      <SpecHeader>
        <div>Setting</div>
        <div>Value</div>
      </SpecHeader>
      <SpecItem defaultOpen>
        <SpecTrigger>
          <div>Model</div>
          <div className="text-muted-foreground">
            <Mono>claude-opus-4-8[1m]</Mono>
          </div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Provider</SpecFieldLabel>
            <SpecFieldValue>Anthropic</SpecFieldValue>
          </SpecField>
          <SpecField>
            <SpecFieldLabel>Context window</SpecFieldLabel>
            <SpecFieldValue>1,000,000 tokens</SpecFieldValue>
          </SpecField>
          <SpecField>
            <SpecFieldLabel>Fallback</SpecFieldLabel>
            <SpecFieldValue>
              <Mono>claude-sonnet-4-5</Mono>
            </SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
      <SpecItem>
        <SpecTrigger>
          <div>Repository</div>
          <div className="text-muted-foreground">
            <Mono>terragon-labs/terragon</Mono>
          </div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Base branch</SpecFieldLabel>
            <SpecFieldValue>
              <Mono>main</Mono>
            </SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
    </Spec>
  </Surface>
);

export const MultipleExpanded: Story = () => (
  <Surface>
    <Spec>
      <SpecHeader>
        <div>Setting</div>
        <div>Value</div>
      </SpecHeader>
      <SpecItem defaultOpen>
        <SpecTrigger>
          <div>Model</div>
          <div className="text-muted-foreground">
            <Mono>claude-opus-4-8[1m]</Mono>
          </div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Provider</SpecFieldLabel>
            <SpecFieldValue>Anthropic</SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
      <SpecItem defaultOpen>
        <SpecTrigger>
          <div>Sandbox</div>
          <div className="text-muted-foreground">E2B</div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Region</SpecFieldLabel>
            <SpecFieldValue>us-east-1</SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
    </Spec>
  </Surface>
);

export const ThreeColumns: Story = () => (
  <Surface>
    <Spec cols="grid-cols-3">
      <SpecHeader>
        <div>Variable</div>
        <div>Type</div>
        <div>Default</div>
      </SpecHeader>
      <SpecItem defaultOpen>
        <SpecTrigger>
          <div>
            <Mono>maxTurns</Mono>
          </div>
          <div className="text-muted-foreground">number</div>
          <div className="text-muted-foreground">50</div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Description</SpecFieldLabel>
            <SpecFieldValue>
              Hard cap on agent turns before the run is force-stopped.
            </SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
      <SpecItem>
        <SpecTrigger>
          <div>
            <Mono>resumePolicy</Mono>
          </div>
          <div className="text-muted-foreground">enum</div>
          <div className="text-muted-foreground">server</div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Description</SpecFieldLabel>
            <SpecFieldValue>
              Whether resume liveness is decided by the server or the client.
            </SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
    </Spec>
  </Surface>
);

export const LongValuesOverflow: Story = () => (
  <Surface>
    <Spec>
      <SpecHeader>
        <div>Setting</div>
        <div>Value</div>
      </SpecHeader>
      <SpecItem defaultOpen>
        <SpecTrigger>
          <div>Command</div>
          <div className="min-w-0 truncate text-muted-foreground">
            <Mono>pnpm -C apps/www test --run route.test.ts</Mono>
          </div>
        </SpecTrigger>
        <SpecContent>
          <SpecField>
            <SpecFieldLabel>Working directory</SpecFieldLabel>
            <SpecFieldValue className="break-all">
              <Mono>
                /home/user/terragon/apps/www/src/app/api/ag-ui/[threadId]/route.test.ts
              </Mono>
            </SpecFieldValue>
          </SpecField>
          <SpecField>
            <SpecFieldLabel>Environment</SpecFieldLabel>
            <SpecFieldValue className="break-all">
              <Mono>
                DATABASE_URL=postgresql://postgres:postgres@localhost:15432/postgres
                REDIS_URL=redis://localhost:16379 NODE_ENV=test
              </Mono>
            </SpecFieldValue>
          </SpecField>
        </SpecContent>
      </SpecItem>
    </Spec>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <Spec>
      <SpecHeader>
        <div>Setting</div>
        <div>Value</div>
      </SpecHeader>
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        No settings configured.
      </div>
    </Spec>
  </Surface>
);

export default {
  title: "ai/spec",
} satisfies StoryDefault;
