export type PromptBoxRef = {
  focus: () => void;
  setPermissionMode: (mode: "allowAll" | "plan") => void;
};
