import Handlebars from "handlebars";
import type { SandboxProvider } from "@terragon/types/sandbox";
import { DOCKERFILE_TEMPLATE } from "./dockerfile-template";

// Register the 'eq' helper
Handlebars.registerHelper("eq", function (a, b) {
  return a === b;
});

export function renderDockerfile(sandboxProvider: SandboxProvider): string {
  const template = Handlebars.compile(DOCKERFILE_TEMPLATE);
  return template({ sandboxProvider });
}
