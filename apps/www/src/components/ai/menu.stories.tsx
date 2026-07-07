import type { Story, StoryDefault } from "@ladle/react";
import {
  Camera,
  Code2,
  FileText,
  Globe,
  Image as ImageIcon,
  Plus,
  Settings2,
  Telescope,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "./button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "./menu";
import { Switch } from "./switch";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Basic: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Add</MenuTrigger>
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
  </Surface>
);

export const GroupsAndSeparators: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Actions</MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>Attach</MenuGroupLabel>
          <MenuItem>
            <Upload />
            Upload file
          </MenuItem>
          <MenuItem>
            <ImageIcon />
            Add image
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Danger</MenuGroupLabel>
          <MenuItem className="text-destructive">
            <Trash2 />
            Delete thread
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  </Surface>
);

export const DisabledItem: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Add</MenuTrigger>
      <MenuPopup>
        <MenuItem>
          <Upload />
          Upload file
        </MenuItem>
        <MenuItem disabled>
          <Camera />
          Screenshot (unavailable)
        </MenuItem>
      </MenuPopup>
    </Menu>
  </Surface>
);

export const CheckboxItems: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Tools</MenuTrigger>
      <MenuPopup>
        <MenuGroupLabel>Enabled tools</MenuGroupLabel>
        <MenuCheckboxItem defaultChecked closeOnClick={false}>
          <Globe />
          Web search
        </MenuCheckboxItem>
        <MenuCheckboxItem closeOnClick={false}>
          <Code2 />
          Code interpreter
        </MenuCheckboxItem>
        <MenuCheckboxItem closeOnClick={false}>
          <Telescope />
          Deep research
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  </Surface>
);

export const SwitchItems: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Tools</MenuTrigger>
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
  </Surface>
);

export const RadioGroupDefault: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>
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
  </Surface>
);

export const RadioGroupAlternate: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>Model</MenuTrigger>
      <MenuPopup>
        <MenuGroupLabel>Model</MenuGroupLabel>
        <MenuRadioGroup defaultValue="opus">
          <MenuRadioItem variant="alternate" value="opus">
            Claude Opus 4.8
          </MenuRadioItem>
          <MenuRadioItem variant="alternate" value="sonnet">
            Claude Sonnet 4.5
          </MenuRadioItem>
          <MenuRadioItem variant="alternate" value="codex">
            GPT-5 Codex
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  </Surface>
);

export const Submenu: Story = () => (
  <Surface>
    <Menu defaultOpen>
      <MenuTrigger render={<Button variant="secondary" />}>
        Settings
      </MenuTrigger>
      <MenuPopup>
        <MenuItem>
          <Settings2 />
          General
        </MenuItem>
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <FileText />
            Model
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuRadioGroup defaultValue="opus">
              <MenuRadioItem value="opus">Claude Opus 4.8</MenuRadioItem>
              <MenuRadioItem value="sonnet">Claude Sonnet 4.5</MenuRadioItem>
              <MenuRadioItem value="codex">GPT-5 Codex</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubmenuPopup>
        </MenuSubmenu>
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <Telescope />
            Reasoning
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuRadioGroup defaultValue="medium">
              <MenuRadioItem value="low">Low</MenuRadioItem>
              <MenuRadioItem value="medium">Medium</MenuRadioItem>
              <MenuRadioItem value="high">High</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </Menu>
  </Surface>
);

export const Closed: Story = () => (
  <Surface>
    <Menu>
      <MenuTrigger render={<Button variant="secondary" />}>
        <Plus />
        Add
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
      </MenuPopup>
    </Menu>
  </Surface>
);

export default {
  title: "ai/menu",
} satisfies StoryDefault;
