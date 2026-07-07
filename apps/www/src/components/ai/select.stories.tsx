import type { Story, StoryDefault } from "@ladle/react";
import { Bot, Cpu, GitBranch, Sparkles, X } from "lucide-react";
import { Chip } from "./chip";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectList,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const opusModel = {
  value: "opus",
  label: "Claude Opus 4.8",
  icon: <Sparkles />,
};
const sonnetModel = {
  value: "sonnet",
  label: "Claude Sonnet 4.5",
  icon: <Bot />,
};
const codexModel = { value: "codex", label: "GPT-5 Codex", icon: <Cpu /> };
const models = [opusModel, sonnetModel, codexModel];

export const Placeholder: Story = () => (
  <Surface>
    <div className="w-56">
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            {models.map((m) => (
              <SelectItem key={m.value} value={m}>
                {m.icon}
                {m.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const Populated: Story = () => (
  <Surface>
    <div className="w-56">
      <Select defaultValue={models[0]}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            {models.map((m) => (
              <SelectItem key={m.value} value={m}>
                {m.icon}
                {m.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const Variants: Story = () => (
  <Surface>
    <div className="flex flex-col gap-3">
      {(["default", "subtle", "plain"] as const).map((variant) => (
        <div key={variant} className="w-56">
          <Select defaultValue={models[0]}>
            <SelectTrigger variant={variant}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectList>
                {models.map((m) => (
                  <SelectItem key={m.value} value={m}>
                    {m.icon}
                    {m.label}
                  </SelectItem>
                ))}
              </SelectList>
            </SelectPopup>
          </Select>
        </div>
      ))}
    </div>
  </Surface>
);

export const PlainModelSelect: Story = () => (
  <Surface>
    <Select defaultValue={models[0]}>
      <SelectTrigger variant="plain" className="w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectList>
          {models.map((m) => (
            <SelectItem key={m.value} value={m}>
              {m.icon}
              {m.label}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopup>
    </Select>
  </Surface>
);

export const Open: Story = () => (
  <Surface>
    <div className="w-56 pb-40">
      <Select defaultValue={models[0]} defaultOpen>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            {models.map((m) => (
              <SelectItem key={m.value} value={m}>
                {m.icon}
                {m.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const Grouped: Story = () => (
  <Surface>
    <div className="w-64 pb-48">
      <Select defaultValue={models[0]} defaultOpen>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            <SelectGroup>
              <SelectGroupLabel>Anthropic</SelectGroupLabel>
              <SelectItem value={opusModel}>
                {opusModel.icon}
                {opusModel.label}
              </SelectItem>
              <SelectItem value={sonnetModel}>
                {sonnetModel.icon}
                {sonnetModel.label}
              </SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>OpenAI</SelectGroupLabel>
              <SelectItem value={codexModel}>
                {codexModel.icon}
                {codexModel.label}
              </SelectItem>
            </SelectGroup>
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const Multiple: Story = () => (
  <Surface>
    <div className="w-56">
      <Select multiple defaultValue={[models[0], models[1]]}>
        <SelectTrigger>
          <SelectValue placeholder="Pick models" />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            {models.map((m) => (
              <SelectItem key={m.value} value={m}>
                {m.icon}
                {m.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const Disabled: Story = () => (
  <Surface>
    <div className="w-56">
      <Select defaultValue={models[0]} disabled>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectList>
            {models.map((m) => (
              <SelectItem key={m.value} value={m}>
                {m.icon}
                {m.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopup>
      </Select>
    </div>
  </Surface>
);

export const LongListOverflow: Story = () => {
  const branches = Array.from({ length: 24 }, (_, i) => ({
    value: `branch-${i}`,
    label: `feature/very-long-branch-name-number-${i}-that-truncates`,
  }));
  return (
    <Surface>
      <div className="w-64 pb-64">
        <Select defaultValue={branches[0]} defaultOpen>
          <SelectTrigger>
            <SelectValue placeholder="Base branch" />
          </SelectTrigger>
          <SelectPopup>
            <SelectList className="max-h-64">
              {branches.map((b) => (
                <SelectItem key={b.value} value={b}>
                  <GitBranch />
                  <span className="truncate">{b.label}</span>
                </SelectItem>
              ))}
            </SelectList>
          </SelectPopup>
        </Select>
      </div>
    </Surface>
  );
};

export const Chips: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Chip>Default</Chip>
      <Chip size="sm">Small</Chip>
      <Chip>
        <Sparkles />
        With icon
      </Chip>
      <Chip size="sm">
        <GitBranch />
        chore/aa
      </Chip>
    </div>
  </Surface>
);

export const ChipsInteractive: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Chip render={<button type="button" />}>
        registry.tsx
        <X />
      </Chip>
      <Chip render={<a href="#" />}>
        <GitBranch />
        View branch
      </Chip>
      <Chip size="sm" render={<button type="button" />}>
        +3 more
      </Chip>
    </div>
  </Surface>
);

export const ChipOverflow: Story = () => (
  <Surface>
    <div className="w-40">
      <Chip className="max-w-full">
        <GitBranch />
        <span className="truncate">
          feature/extremely-long-branch-name-that-must-truncate
        </span>
      </Chip>
    </div>
  </Surface>
);

export default {
  title: "ai/select",
} satisfies StoryDefault;
