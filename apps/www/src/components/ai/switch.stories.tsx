import type { Story, StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Switch } from "./switch";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Off: Story = () => (
  <Surface>
    <Switch aria-label="Web search" />
  </Surface>
);

export const On: Story = () => (
  <Surface>
    <Switch defaultChecked aria-label="Web search" />
  </Surface>
);

export const Sizes: Story = () => (
  <Surface>
    <div className="flex items-center gap-4">
      <Switch size="default" defaultChecked aria-label="Default on" />
      <Switch size="default" aria-label="Default off" />
      <Switch size="sm" defaultChecked aria-label="Small on" />
      <Switch size="sm" aria-label="Small off" />
    </div>
  </Surface>
);

export const Disabled: Story = () => (
  <Surface>
    <div className="flex items-center gap-4">
      <Switch disabled aria-label="Disabled off" />
      <Switch disabled defaultChecked aria-label="Disabled on" />
    </div>
  </Surface>
);

export const Controlled: Story = () => {
  const [checked, setChecked] = useState(false);
  return (
    <Surface>
      <div className="flex items-center gap-3">
        <Switch
          checked={checked}
          onCheckedChange={setChecked}
          aria-label="Deep research"
        />
        <span className="text-sm text-muted-foreground">
          Deep research is {checked ? "on" : "off"}
        </span>
      </div>
    </Surface>
  );
};

export const SettingRows: Story = () => (
  <Surface>
    <div className="flex flex-col gap-3 text-sm text-foreground">
      <label className="flex items-center justify-between gap-6">
        <span>Web search</span>
        <Switch defaultChecked aria-label="Web search" />
      </label>
      <label className="flex items-center justify-between gap-6">
        <span>Code interpreter</span>
        <Switch aria-label="Code interpreter" />
      </label>
      <label className="flex items-center justify-between gap-6 opacity-70">
        <span>Deep research (beta)</span>
        <Switch disabled aria-label="Deep research" />
      </label>
    </div>
  </Surface>
);

export default {
  title: "ai/switch",
} satisfies StoryDefault;
