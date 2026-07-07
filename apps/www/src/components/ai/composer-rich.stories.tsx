import type { Story, StoryDefault } from "@ladle/react";
import { useState } from "react";
import {
  ArrowUp,
  AtSign,
  Bot,
  Camera,
  Code2,
  FileText,
  Globe,
  Hash,
  Image as ImageIcon,
  Mic,
  Plus,
  Sparkles,
  Telescope,
  Upload,
  User,
} from "lucide-react";
import { Button } from "./button";
import {
  Composer,
  ComposerSubmit,
  ComposerToolbar,
  ComposerToolbarSpacer,
} from "./composer";
import {
  ComposerRichInput,
  ComposerSuggestions,
  type ComposerItem,
  type ComposerTrigger,
  type ComposerValue,
} from "./composer-rich";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./menu";
import {
  Select,
  SelectItem,
  SelectList,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Switch } from "./switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const models = [
  { value: "opus", label: "Claude Opus 4.8" },
  { value: "sonnet", label: "Claude Sonnet 4.5" },
  { value: "codex", label: "GPT-5 Codex" },
];

const slashCommands: ComposerItem[] = [
  {
    id: "plan",
    label: "plan",
    description: "Draft a build plan",
    icon: <FileText />,
  },
  {
    id: "review",
    label: "review",
    description: "Review the diff",
    icon: <Sparkles />,
  },
  {
    id: "test",
    label: "test",
    description: "Run the test suite",
    icon: <Code2 />,
  },
  {
    id: "clear",
    label: "clear",
    description: "Clear the conversation",
    icon: <Hash />,
  },
];

const mentions: ComposerItem[] = [
  { id: "registry", label: "registry.tsx", icon: <FileText /> },
  { id: "transport", label: "use-live-transcript.ts", icon: <FileText /> },
  { id: "store", label: "transcript-store", icon: <FileText /> },
  { id: "tyler", label: "tyler", icon: <User /> },
];

const groupedMentions: ComposerItem[] = [
  { id: "registry", label: "registry.tsx", icon: <FileText />, group: "Files" },
  {
    id: "transport",
    label: "use-live-transcript.ts",
    icon: <FileText />,
    group: "Files",
  },
  { id: "tyler", label: "tyler", icon: <User />, group: "People" },
  { id: "claude", label: "claude-bot", icon: <Bot />, group: "People" },
];

const slashWithChildren: ComposerItem[] = [
  {
    id: "model",
    label: "model",
    description: "Switch model",
    icon: <Bot />,
    children: [
      { id: "opus", label: "Claude Opus 4.8" },
      { id: "sonnet", label: "Claude Sonnet 4.5" },
      { id: "codex", label: "GPT-5 Codex" },
    ],
  },
  {
    id: "reasoning",
    label: "reasoning",
    description: "Set reasoning effort",
    icon: <Telescope />,
    children: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
  {
    id: "clear",
    label: "clear",
    description: "Clear the conversation",
    icon: <Hash />,
  },
];

const basicTriggers: Record<string, ComposerTrigger> = {
  "/": { items: slashCommands },
  "@": { items: mentions, action: "insert" },
};

const submenuTriggers: Record<string, ComposerTrigger> = {
  "/": { items: slashWithChildren },
  "@": { items: mentions, action: "insert" },
};

const groupedTriggers: Record<string, ComposerTrigger> = {
  "@": { items: groupedMentions, action: "insert" },
  "/": { items: slashCommands },
};

const PlusMenu = () => (
  <Menu>
    <MenuTrigger render={<Button iconOnly variant="ghost" aria-label="Add" />}>
      <Plus />
    </MenuTrigger>
    <MenuPopup>
      <MenuItem>
        <Upload />
        Upload file
      </MenuItem>
      <MenuItem>
        <ImageIcon />
        Add image
      </MenuItem>
      <MenuItem>
        <Camera />
        Screenshot
      </MenuItem>
    </MenuPopup>
  </Menu>
);

const ToolsMenu = () => (
  <Menu>
    <MenuTrigger render={<Button variant="ghost" />}>Tools</MenuTrigger>
    <MenuPopup>
      <MenuGroupLabel>Toggle tools</MenuGroupLabel>
      <MenuItem closeOnClick={false}>
        <Globe />
        Web search
        <Switch defaultChecked size="sm" aria-label="Web search" />
      </MenuItem>
      <MenuItem closeOnClick={false}>
        <Code2 />
        Code interpreter
        <Switch size="sm" aria-label="Code interpreter" />
      </MenuItem>
      <MenuItem closeOnClick={false}>
        <Telescope />
        Deep research
        <Switch size="sm" aria-label="Deep research" />
      </MenuItem>
    </MenuPopup>
  </Menu>
);

const ModelSelect = () => (
  <Select defaultValue={models[0]}>
    <SelectTrigger variant="plain" className="w-auto">
      <SelectValue />
    </SelectTrigger>
    <SelectPopup>
      <SelectList>
        {models.map((m) => (
          <SelectItem key={m.value} value={m}>
            {m.label}
          </SelectItem>
        ))}
      </SelectList>
    </SelectPopup>
  </Select>
);

const MicButton = () => (
  <Tooltip>
    <TooltipTrigger
      render={<Button iconOnly variant="ghost" aria-label="Dictate" />}
    >
      <Mic />
    </TooltipTrigger>
    <TooltipPopup>Dictate a message</TooltipPopup>
  </Tooltip>
);

const RoundSubmit = () => (
  <ComposerSubmit
    aria-label="Send"
    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40 [&>svg]:size-4"
  >
    <ArrowUp />
  </ComposerSubmit>
);

export const Empty: Story = () => (
  <Surface>
    <Composer>
      <ComposerRichInput
        triggers={basicTriggers}
        placeholder="Type / for commands or @ to mention a file…"
      />
      <ComposerSuggestions />
      <ComposerToolbar>
        <ComposerToolbarSpacer>
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Prefilled: Story = () => (
  <Surface>
    <Composer>
      <ComposerRichInput
        triggers={basicTriggers}
        defaultValue={{
          text: "Refactor {{@:registry}} to fold cleanly",
          segments: [
            { type: "text", value: "Refactor " },
            {
              type: "chip",
              trigger: "@",
              item: { id: "registry", label: "registry.tsx" },
            },
            { type: "text", value: " to fold cleanly" },
          ],
        }}
      />
      <ComposerSuggestions />
      <ComposerToolbar>
        <ComposerToolbarSpacer>
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Disabled: Story = () => (
  <Surface>
    <Composer disabled>
      <ComposerRichInput
        triggers={basicTriggers}
        defaultValue={{
          text: "Waiting for the sandbox…",
          segments: [{ type: "text", value: "Waiting for the sandbox…" }],
        }}
        placeholder="Type / for commands…"
      />
      <ComposerToolbar>
        <ComposerToolbarSpacer>
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Basic: Story = () => (
  <Surface>
    <Composer>
      <ComposerRichInput
        autoFocus
        triggers={basicTriggers}
        placeholder="Type / for commands or @ to mention a file…"
      />
      <ComposerSuggestions />
      <ComposerToolbar>
        <PlusMenu />
        <ToolsMenu />
        <ComposerToolbarSpacer>
          <ModelSelect />
          <MicButton />
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Submenu: Story = () => (
  <Surface>
    <Composer>
      <ComposerRichInput
        autoFocus
        triggers={submenuTriggers}
        placeholder="Type / then drill into model or reasoning…"
      />
      <ComposerSuggestions />
      <ComposerToolbar>
        <PlusMenu />
        <Menu>
          <MenuTrigger render={<Button variant="ghost" />}>
            Reasoning
          </MenuTrigger>
          <MenuPopup>
            <MenuGroupLabel>Reasoning effort</MenuGroupLabel>
            <MenuRadioGroup defaultValue="medium">
              <MenuRadioItem value="low">Low</MenuRadioItem>
              <MenuRadioItem value="medium">Medium</MenuRadioItem>
              <MenuRadioItem value="high">High</MenuRadioItem>
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <ComposerToolbarSpacer>
          <ModelSelect />
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Groups: Story = () => (
  <Surface>
    <Composer>
      <ComposerRichInput
        autoFocus
        triggers={groupedTriggers}
        placeholder="Type @ to mention a file or person…"
      />
      <ComposerSuggestions
        renderGroup={(label) => (
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            {label === "Files" ? (
              <FileText className="size-3" />
            ) : (
              <AtSign className="size-3" />
            )}
            {label}
          </div>
        )}
      />
      <ComposerToolbar>
        <PlusMenu />
        <ComposerToolbarSpacer>
          <ModelSelect />
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

const draftValue: ComposerValue = {
  text: "Refactor {{@:registry}} to use the closed union",
  segments: [
    { type: "text", value: "Refactor " },
    {
      type: "chip",
      trigger: "@",
      item: { id: "registry", label: "registry.tsx" },
    },
    { type: "text", value: " to use the closed union" },
  ],
};

const emptyValue: ComposerValue = { text: "", segments: [] };

export const Controlled: Story = () => {
  const [value, setValue] = useState<ComposerValue>(draftValue);
  return (
    <Surface>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setValue(draftValue)}>
            Load draft
          </Button>
          <Button variant="ghost" onClick={() => setValue(emptyValue)}>
            Clear
          </Button>
        </div>
        <Composer>
          <ComposerRichInput
            triggers={basicTriggers}
            value={value}
            onValueChange={setValue}
            placeholder="Parent-owned value…"
          />
          <ComposerSuggestions />
          <ComposerToolbar>
            <ComposerToolbarSpacer>
              <ModelSelect />
              <RoundSubmit />
            </ComposerToolbarSpacer>
          </ComposerToolbar>
        </Composer>
        <pre className="overflow-x-auto rounded bg-surface-elevated px-3 py-2 font-mono text-xs text-muted-foreground ring ring-border">
          {value.text || "(empty)"}
        </pre>
      </div>
    </Surface>
  );
};

export default {
  title: "ai/composer-rich",
} satisfies StoryDefault;
