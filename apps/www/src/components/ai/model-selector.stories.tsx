import type { Story, StoryDefault } from "@ladle/react";
import {
  ModelSelector,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorGroupLabel,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorItemIcon,
  ModelSelectorItemMeta,
  ModelSelectorItemText,
  ModelSelectorList,
  ModelSelectorSeparator,
} from "./model-selector";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const SparkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M12 3v4m0 10v4m9-9h-4M7 12H3m14.5-6.5-2.8 2.8M9.3 14.7l-2.8 2.8m11 0-2.8-2.8M9.3 9.3 6.5 6.5"
      strokeLinecap="round"
    />
  </svg>
);

const BoltIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinejoin="round" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Default: Story = () => (
  <Surface>
    <div className="max-w-xs">
      <ModelSelector>
        <ModelSelectorInput placeholder="Search models" />
        <ModelSelectorSeparator />
        <ModelSelectorList>
          <ModelSelectorItem value="claude-opus">
            <ModelSelectorItemIcon>
              <SparkIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>Claude Opus 4.8</ModelSelectorItemText>
            <ModelSelectorItemMeta>Most capable</ModelSelectorItemMeta>
          </ModelSelectorItem>
          <ModelSelectorItem value="claude-sonnet">
            <ModelSelectorItemIcon>
              <SparkIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>Claude Sonnet 4.5</ModelSelectorItemText>
            <ModelSelectorItemMeta>Balanced</ModelSelectorItemMeta>
          </ModelSelectorItem>
          <ModelSelectorItem value="gpt-5-codex">
            <ModelSelectorItemIcon>
              <BoltIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>GPT-5 Codex</ModelSelectorItemText>
            <ModelSelectorItemMeta>Fast</ModelSelectorItemMeta>
          </ModelSelectorItem>
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export const Grouped: Story = () => (
  <Surface>
    <div className="max-w-xs">
      <ModelSelector>
        <ModelSelectorInput placeholder="Search models" />
        <ModelSelectorSeparator />
        <ModelSelectorList>
          <ModelSelectorGroup>
            <ModelSelectorGroupLabel>Claude</ModelSelectorGroupLabel>
            <ModelSelectorItem value="claude-opus">
              <ModelSelectorItemIcon>
                <SparkIcon />
              </ModelSelectorItemIcon>
              <ModelSelectorItemText>Claude Opus 4.8</ModelSelectorItemText>
              <ModelSelectorItemIcon className="text-primary">
                <CheckIcon />
              </ModelSelectorItemIcon>
            </ModelSelectorItem>
            <ModelSelectorItem value="claude-sonnet">
              <ModelSelectorItemIcon>
                <SparkIcon />
              </ModelSelectorItemIcon>
              <ModelSelectorItemText>Claude Sonnet 4.5</ModelSelectorItemText>
            </ModelSelectorItem>
          </ModelSelectorGroup>
          <ModelSelectorSeparator />
          <ModelSelectorGroup>
            <ModelSelectorGroupLabel>Codex</ModelSelectorGroupLabel>
            <ModelSelectorItem value="gpt-5-codex">
              <ModelSelectorItemIcon>
                <BoltIcon />
              </ModelSelectorItemIcon>
              <ModelSelectorItemText>GPT-5 Codex</ModelSelectorItemText>
              <ModelSelectorItemMeta>Fast</ModelSelectorItemMeta>
            </ModelSelectorItem>
            <ModelSelectorItem value="gpt-5-mini" disabled>
              <ModelSelectorItemIcon>
                <BoltIcon />
              </ModelSelectorItemIcon>
              <ModelSelectorItemText>GPT-5 Mini</ModelSelectorItemText>
              <ModelSelectorItemMeta>Unavailable</ModelSelectorItemMeta>
            </ModelSelectorItem>
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export const PlainVariant: Story = () => (
  <Surface>
    <div className="max-w-xs rounded-outer bg-surface ring ring-border p-1">
      <ModelSelector variant="plain">
        <ModelSelectorList>
          <ModelSelectorItem value="claude-opus">
            <ModelSelectorItemIcon>
              <SparkIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>Claude Opus 4.8</ModelSelectorItemText>
          </ModelSelectorItem>
          <ModelSelectorItem value="claude-sonnet">
            <ModelSelectorItemIcon>
              <SparkIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>Claude Sonnet 4.5</ModelSelectorItemText>
          </ModelSelectorItem>
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <div className="max-w-xs">
      <ModelSelector>
        <ModelSelectorInput placeholder="Search models" />
        <ModelSelectorSeparator />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models match your search.</ModelSelectorEmpty>
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export const LongListOverflow: Story = () => (
  <Surface>
    <div className="max-w-xs">
      <ModelSelector>
        <ModelSelectorInput placeholder="Search models" />
        <ModelSelectorSeparator />
        <ModelSelectorList>
          {Array.from({ length: 16 }, (_, i) => (
            <ModelSelectorItem key={i} value={`model-${i}`}>
              <ModelSelectorItemIcon>
                {i % 2 === 0 ? <SparkIcon /> : <BoltIcon />}
              </ModelSelectorItemIcon>
              <ModelSelectorItemText>
                {i % 2 === 0 ? "Claude" : "Codex"} checkpoint {2000 + i}
              </ModelSelectorItemText>
              <ModelSelectorItemMeta>{200 - i}k ctx</ModelSelectorItemMeta>
            </ModelSelectorItem>
          ))}
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export const TruncatedItemText: Story = () => (
  <Surface>
    <div className="max-w-[14rem]">
      <ModelSelector>
        <ModelSelectorList>
          <ModelSelectorItem value="long">
            <ModelSelectorItemIcon>
              <SparkIcon />
            </ModelSelectorItemIcon>
            <ModelSelectorItemText>
              Claude Opus 4.8 (1M context) preview build for internal evaluation
            </ModelSelectorItemText>
            <ModelSelectorItemMeta>1M</ModelSelectorItemMeta>
          </ModelSelectorItem>
        </ModelSelectorList>
      </ModelSelector>
    </div>
  </Surface>
);

export default {
  title: "ai/model-selector",
} satisfies StoryDefault;
