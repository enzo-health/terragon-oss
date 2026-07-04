import type { Story, StoryDefault } from "@ladle/react";
import { ArrowUp, Globe, Mic, Plus, Quote, Telescope, X } from "lucide-react";
import { Button } from "./button";
import {
  Composer,
  ComposerInput,
  ComposerQuote,
  ComposerQuoteContent,
  ComposerQuoteDismiss,
  ComposerQuoteIcon,
  ComposerSubmit,
  ComposerToolbar,
  ComposerToolbarSpacer,
} from "./composer";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./menu";
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

const RoundSubmit = () => (
  <ComposerSubmit
    aria-label="Send"
    className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40 [&>svg]:size-4"
  >
    <ArrowUp />
  </ComposerSubmit>
);

export const Empty: Story = () => (
  <Surface>
    <Composer>
      <ComposerInput placeholder="Ask Terragon to build something…" />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Prefilled: Story = () => (
  <Surface>
    <Composer>
      <ComposerInput defaultValue="Add a Ladle story for the composer toolbar" />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const Disabled: Story = () => (
  <Surface>
    <Composer disabled>
      <ComposerInput
        defaultValue="Waiting for the sandbox to finish booting…"
        placeholder="Ask Terragon to build something…"
      />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const WithQuote: Story = () => (
  <Surface>
    <Composer>
      <ComposerQuote>
        <ComposerQuoteIcon>
          <Quote />
        </ComposerQuoteIcon>
        <ComposerQuoteContent>
          {`export function TranscriptStore(events) {\n  return events.reduce(fold, seed);\n}`}
        </ComposerQuoteContent>
        <ComposerQuoteDismiss aria-label="Remove quote">
          <X />
        </ComposerQuoteDismiss>
      </ComposerQuote>
      <ComposerInput placeholder="Ask about the selected code…" />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const QuoteOverflow: Story = () => (
  <Surface>
    <Composer>
      <ComposerQuote>
        <ComposerQuoteIcon>
          <Quote />
        </ComposerQuoteIcon>
        <ComposerQuoteContent>
          {Array.from(
            { length: 12 },
            (_, i) =>
              `line ${i}: registry maps TranscriptItem kind ${i} to a leaf`,
          ).join("\n")}
        </ComposerQuoteContent>
        <ComposerQuoteDismiss aria-label="Remove quote">
          <X />
        </ComposerQuoteDismiss>
      </ComposerQuote>
      <ComposerInput placeholder="Ask about the selected code…" />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const InputOverflow: Story = () => (
  <Surface>
    <Composer>
      <ComposerInput
        maxRows={6}
        defaultValue={Array.from(
          { length: 14 },
          (_, i) =>
            `Requirement ${i + 1}: cover every state in the story file.`,
        ).join("\n")}
      />
      <ComposerToolbar>
        <RoundSubmit />
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export const FullToolbar: Story = () => (
  <Surface>
    <Composer>
      <ComposerInput
        defaultValue="Refactor the transcript registry"
        placeholder="Ask Terragon to build something…"
      />
      <ComposerToolbar>
        <Menu>
          <MenuTrigger
            render={<Button iconOnly variant="ghost" aria-label="Add" />}
          >
            <Plus />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem>Upload file</MenuItem>
            <MenuItem>Add image</MenuItem>
            <MenuItem>Screenshot</MenuItem>
          </MenuPopup>
        </Menu>
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
              <Telescope />
              Deep research
              <Switch size="sm" aria-label="Deep research" />
            </MenuItem>
          </MenuPopup>
        </Menu>
        <ComposerToolbarSpacer>
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
          <Tooltip>
            <TooltipTrigger
              render={<Button iconOnly variant="ghost" aria-label="Dictate" />}
            >
              <Mic />
            </TooltipTrigger>
            <TooltipPopup>Dictate a message</TooltipPopup>
          </Tooltip>
          <RoundSubmit />
        </ComposerToolbarSpacer>
      </ComposerToolbar>
    </Composer>
  </Surface>
);

export default {
  title: "ai/composer",
} satisfies StoryDefault;
