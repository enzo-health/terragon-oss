import type { Story, StoryDefault } from "@ladle/react";
import { Source, SourceDescription, SourceName, SourceTitle } from "./source";

export const Default: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Source>
        <SourceName>
          <img src="https://nextjs.org/favicon.ico" alt="" />
          nextjs.org
        </SourceName>
        <SourceTitle>App Router: Data Fetching and Caching</SourceTitle>
        <SourceDescription>
          Learn how to fetch, cache, and revalidate data in the Next.js App
          Router using server components and the extended fetch API.
        </SourceDescription>
      </Source>
    </div>
  );
};

export const Plain: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Source variant="plain">
        <SourceName>
          <img src="https://vitejs.dev/logo.svg" alt="" />
          vitejs.dev
        </SourceName>
        <SourceTitle>Configuring Vite</SourceTitle>
        <SourceDescription>
          Reference for the vite.config.ts options including resolve.alias,
          server.proxy, and build.rollupOptions.
        </SourceDescription>
      </Source>
    </div>
  );
};

export const WithThumbnail: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Source>
        <img
          data-slot="source-thumbnail"
          src="https://placehold.co/640x360/png"
          alt=""
        />
        <SourceName>
          <img src="https://github.com/favicon.ico" alt="" />
          github.com
        </SourceName>
        <SourceTitle>terragon-labs/terragon</SourceTitle>
        <SourceDescription>
          AI-powered coding assistant platform that runs coding agents in
          parallel inside remote sandboxes.
        </SourceDescription>
      </Source>
    </div>
  );
};

export const NameOnly: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Source>
        <SourceName>docs.anthropic.com</SourceName>
      </Source>
    </div>
  );
};

export const LongContentOverflow: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Source>
        <SourceName>
          <img src="https://developer.mozilla.org/favicon.ico" alt="" />
          developer.mozilla.org
        </SourceName>
        <SourceTitle>
          RequestInit.signal and AbortController: cancelling fetch requests
          across streaming responses, server-sent events, and long-running
          uploads on unreliable mobile networks
        </SourceTitle>
        <SourceDescription>
          The signal read-only property of the RequestInit interface is an
          AbortSignal object instance, which allows you to communicate with a
          fetch request and abort it if desired via an AbortController. This
          long description intentionally repeats to exercise wrapping and
          vertical overflow behavior inside the fixed-width source card so the
          scoped tokens and leading are visible under real chat constraints.
        </SourceDescription>
      </Source>
    </div>
  );
};

export const SourceList: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl space-y-2">
      <Source>
        <SourceName>react.dev</SourceName>
        <SourceTitle>useEffect</SourceTitle>
        <SourceDescription>
          useEffect is a React Hook that lets you synchronize a component with
          an external system.
        </SourceDescription>
      </Source>
      <Source variant="plain">
        <SourceName>tanstack.com</SourceName>
        <SourceTitle>Query Invalidation</SourceTitle>
        <SourceDescription>
          Invalidating queries is a smart way to mark them as stale and
          potentially refetch them.
        </SourceDescription>
      </Source>
      <Source>
        <SourceName>orm.drizzle.team</SourceName>
        <SourceTitle>Drizzle ORM: JSONB columns</SourceTitle>
        <SourceDescription>
          Store and query structured JSONB with typed $type helpers on
          PostgreSQL tables.
        </SourceDescription>
      </Source>
    </div>
  );
};

export default {
  title: "ai/source",
} satisfies StoryDefault;
