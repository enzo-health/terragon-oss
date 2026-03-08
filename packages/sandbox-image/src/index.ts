import templates from "../templates.json";
import type { SandboxSize, SandboxProvider } from "@terragon/types/sandbox";

export { renderDockerfile } from "./render-dockerfile";
export { getDaytonaBaseCommands } from "./daytona-base";

interface TemplateEntry {
  name: string;
  dockerfileHash: string;
  createdAt: string;
  cpuCount?: number;
  memoryGB?: number;
  provider?: SandboxProvider;
  size?: SandboxSize;
}

// Filter templates by resource configuration
export function getTemplateIdForSize({
  provider,
  size,
}: {
  provider: SandboxProvider;
  size: SandboxSize;
}): string {
  const typedTemplates = templates as TemplateEntry[];
  const matchingTemplates = typedTemplates.filter((t) => {
    return t.provider === provider && t.size === size;
  });
  if (matchingTemplates.length === 0) {
    throw new Error(`No template found for ${provider} ${size}`);
  }
  const matchingTemplate = matchingTemplates[matchingTemplates.length - 1]!;
  const name = matchingTemplate.name;
  console.log(
    `Found template: ${name} for ${provider} ${size} (${matchingTemplate.cpuCount} vCPU, ${matchingTemplate.memoryGB}GB)`,
  );
  return name;
}
