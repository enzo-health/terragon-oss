import type { Story, StoryDefault } from "@ladle/react";
import {
  AnimatedNumber,
  UsageBar,
  UsageMeter,
  UsageStat,
  UsageStatLabel,
  UsageStatValue,
} from "./usage-meter";

export const DefaultStats: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageStat>
          <UsageStatLabel>Input</UsageStatLabel>
          <UsageStatValue>18,204</UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Output</UsageStatLabel>
          <UsageStatValue>3,912</UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Cache read</UsageStatLabel>
          <UsageStatValue>142,880</UsageStatValue>
        </UsageStat>
      </UsageMeter>
    </div>
  );
};

export const SmallSize: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter size="sm">
        <UsageStat>
          <UsageStatLabel>Input</UsageStatLabel>
          <UsageStatValue>18,204</UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Output</UsageStatLabel>
          <UsageStatValue>3,912</UsageStatValue>
        </UsageStat>
        <UsageBar value={92_000} max={200_000}>
          <UsageStatLabel>Context</UsageStatLabel>
          <UsageStatValue>92k / 200k</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const BarUnder: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageBar value={64_000} max={200_000}>
          <UsageStatLabel>Context window</UsageStatLabel>
          <UsageStatValue>64k / 200k</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const BarOver: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageBar value={186_500} max={200_000}>
          <UsageStatLabel>Context window</UsageStatLabel>
          <UsageStatValue>186.5k / 200k</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const BarAtThreshold: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageBar value={160_000} max={200_000}>
          <UsageStatLabel>Context window</UsageStatLabel>
          <UsageStatValue>160k / 200k</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const BarNoLabels: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageBar value={45_000} max={200_000} />
      </UsageMeter>
    </div>
  );
};

export const EmptyZero: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageStat>
          <UsageStatLabel>Input</UsageStatLabel>
          <UsageStatValue>0</UsageStatValue>
        </UsageStat>
        <UsageBar value={0} max={0}>
          <UsageStatLabel>Context window</UsageStatLabel>
          <UsageStatValue>0 / 0</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const AnimatedValue: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageStat>
          <UsageStatLabel>Total tokens</UsageStatLabel>
          <UsageStatValue>
            <AnimatedNumber value={164_996} />
          </UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Cost</UsageStatLabel>
          <UsageStatValue>
            <AnimatedNumber value={2.47} format={(n) => `$${n.toFixed(2)}`} />
          </UsageStatValue>
        </UsageStat>
      </UsageMeter>
    </div>
  );
};

export const FullMeter: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter>
        <UsageStat>
          <UsageStatLabel>Input</UsageStatLabel>
          <UsageStatValue>
            <AnimatedNumber value={18_204} />
          </UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Output</UsageStatLabel>
          <UsageStatValue>
            <AnimatedNumber value={3_912} />
          </UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Cache read</UsageStatLabel>
          <UsageStatValue>
            <AnimatedNumber value={142_880} />
          </UsageStatValue>
        </UsageStat>
        <UsageBar value={165_000} max={200_000}>
          <UsageStatLabel>Context window</UsageStatLabel>
          <UsageStatValue>165k / 200k</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export const LargeNumbersOverflow: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <UsageMeter size="sm">
        <UsageStat>
          <UsageStatLabel>Cache read</UsageStatLabel>
          <UsageStatValue>1,284,559,102</UsageStatValue>
        </UsageStat>
        <UsageStat>
          <UsageStatLabel>Cache write</UsageStatLabel>
          <UsageStatValue>998,001,743</UsageStatValue>
        </UsageStat>
        <UsageBar value={1_048_576} max={1_048_576}>
          <UsageStatLabel>1M context window</UsageStatLabel>
          <UsageStatValue>1,048,576 / 1,048,576</UsageStatValue>
        </UsageBar>
      </UsageMeter>
    </div>
  );
};

export default {
  title: "ai/usage-meter",
} satisfies StoryDefault;
