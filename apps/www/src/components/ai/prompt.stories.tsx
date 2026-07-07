import type { Story, StoryDefault } from "@ladle/react";
import {
  Prompt,
  PromptFooter,
  PromptHint,
  PromptOption,
  PromptOptionOther,
  PromptQuestion,
  PromptStep,
  PromptSubmit,
} from "./prompt";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const submitButton =
  "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90";

export const SingleStep: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt>
        <PromptStep name="base-branch">
          <PromptQuestion>
            Which base branch should the agent open its PR against?
          </PromptQuestion>
          <PromptOption value="main">main</PromptOption>
          <PromptOption value="develop">develop</PromptOption>
          <PromptOption value="release/2026-07">release/2026-07</PromptOption>
          <PromptFooter>
            <PromptHint keys="↑↓">Navigate</PromptHint>
            <PromptHint keys="↵">Select</PromptHint>
          </PromptFooter>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export const WithOtherOption: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt>
        <PromptStep name="framework">
          <PromptQuestion>What should we scaffold the app with?</PromptQuestion>
          <PromptOption value="next">Next.js</PromptOption>
          <PromptOption value="remix">Remix</PromptOption>
          <PromptOption value="vite">Vite + React</PromptOption>
          <PromptOptionOther placeholder="Something else…" />
          <PromptFooter>
            <PromptHint keys="↵">Submit</PromptHint>
            <PromptSubmit className={submitButton}>Continue</PromptSubmit>
          </PromptFooter>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export const MultiStep: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt>
        <PromptStep name="provider">
          <PromptQuestion>
            Which coding agent should run this task?
          </PromptQuestion>
          <PromptOption value="claude">Claude</PromptOption>
          <PromptOption value="codex">Codex</PromptOption>
          <PromptFooter>
            <PromptHint keys="↵">Next</PromptHint>
          </PromptFooter>
        </PromptStep>
        <PromptStep name="sandbox">
          <PromptQuestion>Pick a sandbox provider.</PromptQuestion>
          <PromptOption value="e2b">E2B</PromptOption>
          <PromptOption value="daytona">Daytona</PromptOption>
          <PromptOption value="docker">Docker (local)</PromptOption>
          <PromptFooter>
            <PromptHint keys="⇧⇥">Back</PromptHint>
            <PromptHint keys="↵">Next</PromptHint>
          </PromptFooter>
        </PromptStep>
        <PromptStep name="confirm">
          <PromptQuestion>Ready to launch?</PromptQuestion>
          <PromptOption value="yes">Yes, start the run</PromptOption>
          <PromptOption value="no">Not yet</PromptOption>
          <PromptFooter>
            <PromptHint keys="⎋">Dismiss</PromptHint>
            <PromptSubmit className={submitButton}>Launch</PromptSubmit>
          </PromptFooter>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export const DefaultValue: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt defaultValues={{ "base-branch": "develop" }}>
        <PromptStep name="base-branch">
          <PromptQuestion>Which base branch?</PromptQuestion>
          <PromptOption value="main">main</PromptOption>
          <PromptOption value="develop">develop</PromptOption>
          <PromptOption value="staging">staging</PromptOption>
          <PromptFooter>
            <PromptHint keys="↵">Select</PromptHint>
          </PromptFooter>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export const SubmitOnClick: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt submitOnClick>
        <PromptStep name="visibility">
          <PromptQuestion>Share this task read-only?</PromptQuestion>
          <PromptOption value="private">Keep private</PromptOption>
          <PromptOption value="link">Anyone with the link</PromptOption>
          <PromptOption value="org">Everyone in the org</PromptOption>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export const ManyOptionsOverflow: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Prompt>
        <PromptStep name="repo">
          <PromptQuestion>Choose a repository.</PromptQuestion>
          {Array.from({ length: 9 }, (_, i) => (
            <PromptOption key={i} value={`repo-${i}`}>
              acme/service-{i} — a longer repository description that keeps
              going past the edge to show truncation
            </PromptOption>
          ))}
          <PromptOptionOther placeholder="owner/repo" />
          <PromptFooter>
            <PromptHint keys="1-9">Jump</PromptHint>
            <PromptSubmit className={submitButton}>Select</PromptSubmit>
          </PromptFooter>
        </PromptStep>
      </Prompt>
    </div>
  </Surface>
);

export default {
  title: "ai/prompt",
} satisfies StoryDefault;
