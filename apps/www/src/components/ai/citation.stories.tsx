import type { Story, StoryDefault } from "@ladle/react";
import {
  Citation,
  CitationAction,
  CitationContent,
  CitationDescription,
  CitationHeader,
  CitationIndicator,
  CitationItem,
  CitationList,
  CitationName,
  CitationNav,
  CitationNext,
  CitationPopup,
  CitationPrev,
  CitationTitle,
  CitationTrigger,
} from "./citation";

export const Collapsed: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <p className="text-sm text-foreground">
        The App Router caches fetch responses by default
        <Citation>
          <CitationTrigger>1</CitationTrigger>
          <CitationPopup>
            <CitationList>
              <CitationItem>
                <CitationName>nextjs.org</CitationName>
                <CitationTitle>Caching in Next.js</CitationTitle>
                <CitationDescription>
                  By default, Next.js caches the result of fetch requests in the
                  Data Cache.
                </CitationDescription>
              </CitationItem>
            </CitationList>
          </CitationPopup>
        </Citation>
        , which you can opt out of per request.
      </p>
    </div>
  );
};

export const ExpandedSingle: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <p className="text-sm text-foreground">
        Server components run on the server
        <Citation defaultOpen>
          <CitationTrigger>1</CitationTrigger>
          <CitationPopup>
            <CitationList>
              <CitationItem>
                <CitationName>
                  <img src="https://react.dev/favicon.ico" alt="" />
                  react.dev
                </CitationName>
                <CitationTitle>Server Components</CitationTitle>
                <CitationDescription>
                  Server Components are a new type of Component that renders
                  ahead of time, before bundling, in an environment separate
                  from your client app or SSR server.
                </CitationDescription>
              </CitationItem>
            </CitationList>
          </CitationPopup>
        </Citation>
        .
      </p>
    </div>
  );
};

export const ExpandedMultipleWithNav: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <p className="text-sm text-foreground">
        Drizzle supports JSONB columns on PostgreSQL
        <Citation defaultOpen>
          <CitationTrigger>3</CitationTrigger>
          <CitationPopup>
            <CitationHeader>
              <CitationNav>
                <CitationPrev className="text-muted-foreground hover:text-foreground">
                  Prev
                </CitationPrev>
                <CitationNext className="text-muted-foreground hover:text-foreground">
                  Next
                </CitationNext>
                <CitationIndicator />
              </CitationNav>
            </CitationHeader>
            <CitationList>
              <CitationItem>
                <CitationName>orm.drizzle.team</CitationName>
                <CitationTitle>JSONB column type</CitationTitle>
                <CitationDescription>
                  Use the jsonb helper with a $type annotation to store typed
                  discriminated unions.
                </CitationDescription>
              </CitationItem>
              <CitationItem>
                <CitationName>postgresql.org</CitationName>
                <CitationTitle>8.14. JSON Types</CitationTitle>
                <CitationDescription>
                  The jsonb type stores data in a decomposed binary format that
                  is slower to input but faster to process.
                </CitationDescription>
              </CitationItem>
              <CitationItem>
                <CitationName>github.com</CitationName>
                <CitationTitle>db-message.ts</CitationTitle>
                <CitationDescription>
                  DBMessage is a JSONB-stored discriminated union with a schema
                  version constant.
                </CitationDescription>
              </CitationItem>
            </CitationList>
          </CitationPopup>
        </Citation>
        .
      </p>
    </div>
  );
};

export const ExpandedWithContentAndAction: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <p className="text-sm text-foreground">
        The fetch API is extended with caching semantics
        <Citation defaultOpen>
          <CitationTrigger>1</CitationTrigger>
          <CitationPopup>
            <CitationList>
              <CitationItem>
                <CitationName>nextjs.org</CitationName>
                <CitationTitle>fetch options.next.revalidate</CitationTitle>
                <CitationContent>
                  <p>
                    Set the cache lifetime of a resource in seconds. Passing 0
                    opts out of caching entirely.
                  </p>
                  <pre className="text-xs">
                    {`fetch("https://api.example.com/data", {
  next: { revalidate: 3600 },
});`}
                  </pre>
                </CitationContent>
                <CitationAction>Open source</CitationAction>
              </CitationItem>
            </CitationList>
          </CitationPopup>
        </Citation>
        .
      </p>
    </div>
  );
};

export const ExpandedLongDescriptionClamp: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <p className="text-sm text-foreground">
        AbortController cancels in-flight requests
        <Citation defaultOpen>
          <CitationTrigger>1</CitationTrigger>
          <CitationPopup>
            <CitationList>
              <CitationItem>
                <CitationName>developer.mozilla.org</CitationName>
                <CitationTitle>AbortController</CitationTitle>
                <CitationDescription>
                  The AbortController interface represents a controller object
                  that allows you to abort one or more Web requests as and when
                  desired. This description intentionally runs long to exercise
                  the three-line clamp applied to citation descriptions so the
                  truncation and ellipsis behavior is visible within the fixed
                  popup width under the scoped chat tokens.
                </CitationDescription>
              </CitationItem>
            </CitationList>
          </CitationPopup>
        </Citation>
        .
      </p>
    </div>
  );
};

export default {
  title: "ai/citation",
} satisfies StoryDefault;
