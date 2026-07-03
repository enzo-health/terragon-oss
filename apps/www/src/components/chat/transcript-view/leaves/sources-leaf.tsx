"use client";

import { Source, SourceName, SourceTitle } from "@/components/ai/source";
import type { Leaf } from "../leaf-props";

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const SourcesLeaf: Leaf<"sources"> = ({ item }) => (
  <div className="my-2 flex flex-col gap-2">
    {item.query ? (
      <div className="text-xs text-muted-foreground">
        Searched: {item.query}
      </div>
    ) : null}
    {item.sources.map((source, index) => {
      const title = source.title ?? source.url ?? "Source";
      if (!source.url) {
        return (
          <Source key={index}>
            <SourceTitle>{title}</SourceTitle>
          </Source>
        );
      }
      return (
        <Source
          key={index}
          render={<a href={source.url} target="_blank" rel="noreferrer" />}
        >
          <SourceTitle>{title}</SourceTitle>
          <SourceName>{hostname(source.url)}</SourceName>
        </Source>
      );
    })}
  </div>
);
