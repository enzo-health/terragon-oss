import type { Story, StoryDefault } from "@ladle/react";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeFolderPanel,
  FileTreeIcon,
  FileTreeLabel,
  FileTreeNew,
  FileTreeRow,
} from "./file-tree";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-md">{children}</div>
);

const FolderIcon = () => (
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
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const FileIcon = () => (
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
  >
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

type FileNode = { name: string; value: string; type: "file" };
type FolderNode = {
  name: string;
  value: string;
  type: "folder";
  children: Node[];
};
type Node = FileNode | FolderNode;

const TREE: Node[] = [
  {
    name: "apps",
    value: "apps",
    type: "folder",
    children: [
      {
        name: "www",
        value: "apps/www",
        type: "folder",
        children: [
          {
            name: "src",
            value: "apps/www/src",
            type: "folder",
            children: [
              {
                name: "components",
                value: "apps/www/src/components",
                type: "folder",
                children: [
                  {
                    name: "chat",
                    value: "apps/www/src/components/chat",
                    type: "folder",
                    children: [
                      {
                        name: "transcript-view",
                        value: "apps/www/src/components/chat/transcript-view",
                        type: "folder",
                        children: [
                          {
                            name: "registry.tsx",
                            value:
                              "apps/www/src/components/chat/transcript-view/registry.tsx",
                            type: "file",
                          },
                          {
                            name: "use-live-transcript.ts",
                            value:
                              "apps/www/src/components/chat/transcript-view/use-live-transcript.ts",
                            type: "file",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                name: "agent",
                value: "apps/www/src/agent",
                type: "folder",
                children: [
                  {
                    name: "orchestrator.ts",
                    value: "apps/www/src/agent/orchestrator.ts",
                    type: "file",
                  },
                ],
              },
            ],
          },
          {
            name: "package.json",
            value: "apps/www/package.json",
            type: "file",
          },
        ],
      },
    ],
  },
  {
    name: "packages",
    value: "packages",
    type: "folder",
    children: [
      {
        name: "shared",
        value: "packages/shared",
        type: "folder",
        children: [
          {
            name: "db-message.ts",
            value: "packages/shared/src/db/db-message.ts",
            type: "file",
          },
        ],
      },
    ],
  },
  { name: "AGENTS.md", value: "AGENTS.md", type: "file" },
  { name: "package.json", value: "package.json", type: "file" },
];

function renderNode(node: Node) {
  if (node.type === "folder") {
    return (
      <FileTreeFolder key={node.value} value={node.value}>
        <FileTreeRow>
          <FileTreeIcon>
            <FolderIcon />
          </FileTreeIcon>
          <FileTreeLabel>{node.name}</FileTreeLabel>
        </FileTreeRow>
        <FileTreeFolderPanel>
          {node.children.map(renderNode)}
        </FileTreeFolderPanel>
      </FileTreeFolder>
    );
  }
  return (
    <FileTreeFile key={node.value} value={node.value}>
      <FileTreeRow>
        <FileTreeIcon>
          <FileIcon />
        </FileTreeIcon>
        <FileTreeLabel>{node.name}</FileTreeLabel>
      </FileTreeRow>
    </FileTreeFile>
  );
}

const ALL_FOLDERS = [
  "apps",
  "apps/www",
  "apps/www/src",
  "apps/www/src/components",
  "apps/www/src/components/chat",
  "apps/www/src/components/chat/transcript-view",
  "apps/www/src/agent",
  "packages",
  "packages/shared",
];

export const Collapsed: Story = () => (
  <Surface>
    <FileTree>{TREE.map(renderNode)}</FileTree>
  </Surface>
);

export const Expanded: Story = () => (
  <Surface>
    <FileTree defaultExpanded={ALL_FOLDERS}>{TREE.map(renderNode)}</FileTree>
  </Surface>
);

export const PartiallyExpanded: Story = () => (
  <Surface>
    <FileTree defaultExpanded={["apps", "apps/www", "packages"]}>
      {TREE.map(renderNode)}
    </FileTree>
  </Surface>
);

export const WithGuides: Story = () => (
  <Surface>
    <FileTree guides defaultExpanded={ALL_FOLDERS}>
      {TREE.map(renderNode)}
    </FileTree>
  </Surface>
);

export const Selected: Story = () => (
  <Surface>
    <FileTree
      defaultExpanded={ALL_FOLDERS}
      defaultSelected="apps/www/src/components/chat/transcript-view/registry.tsx"
    >
      {TREE.map(renderNode)}
    </FileTree>
  </Surface>
);

export const KeyboardHighlight: Story = () => (
  <Surface>
    <FileTree
      highlight
      defaultExpanded={ALL_FOLDERS}
      defaultHighlighted="apps/www/src/agent/orchestrator.ts"
    >
      {TREE.map(renderNode)}
    </FileTree>
  </Surface>
);

export const RenamingRow: Story = () => (
  <Surface>
    <FileTree defaultExpanded={["apps", "apps/www"]}>
      <FileTreeFolder value="apps">
        <FileTreeRow>
          <FileTreeIcon>
            <FolderIcon />
          </FileTreeIcon>
          <FileTreeLabel>apps</FileTreeLabel>
        </FileTreeRow>
        <FileTreeFolderPanel>
          <FileTreeFolder value="apps/www">
            <FileTreeRow>
              <FileTreeIcon>
                <FolderIcon />
              </FileTreeIcon>
              <FileTreeLabel>www</FileTreeLabel>
            </FileTreeRow>
            <FileTreeFolderPanel>
              <FileTreeFile value="apps/www/renamed.ts" renaming>
                <FileTreeRow>
                  <FileTreeIcon>
                    <FileIcon />
                  </FileTreeIcon>
                  <input
                    defaultValue="renamed.ts"
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                  />
                </FileTreeRow>
              </FileTreeFile>
              <FileTreeNew>
                <FileTreeIcon>
                  <FileIcon />
                </FileTreeIcon>
                <input
                  placeholder="new-file.ts"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </FileTreeNew>
            </FileTreeFolderPanel>
          </FileTreeFolder>
        </FileTreeFolderPanel>
      </FileTreeFolder>
    </FileTree>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <FileTree>
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        No files changed.
      </div>
    </FileTree>
  </Surface>
);

export default {
  title: "ai/file-tree",
} satisfies StoryDefault;
