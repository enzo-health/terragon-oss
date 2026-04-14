import type { Story, StoryDefault } from "@ladle/react";
import { ResourceLinkView } from "./resource-link-view";
import type { DBResourceLinkPart } from "@terragon/shared";

export default {
  title: "Chat/ResourceLinkView",
} satisfies StoryDefault;

export const Basic: Story = () => {
  const part: DBResourceLinkPart = {
    type: "resource-link",
    uri: "https://example.com/api-docs.pdf",
    name: "api-docs.pdf",
  };
  return (
    <div className="p-4 max-w-sm">
      <ResourceLinkView part={part} />
    </div>
  );
};

export const WithAllFields: Story = () => {
  const part: DBResourceLinkPart = {
    type: "resource-link",
    uri: "https://example.com/report.pdf",
    name: "Q4-report.pdf",
    title: "Q4 Financial Report 2025",
    description:
      "Annual Q4 financial summary including revenue, costs, and projections for 2026.",
    mimeType: "application/pdf",
    size: 245760,
  };
  return (
    <div className="p-4 max-w-sm">
      <ResourceLinkView part={part} />
    </div>
  );
};
