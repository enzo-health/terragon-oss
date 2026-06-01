import {
  updateThreadChatWithTransition,
  type UpdateThreadChatWithTransitionParams,
  type UpdateThreadChatWithTransitionResult,
} from "@/agent/update-status";

export type ThreadLifecycleCommandInput = UpdateThreadChatWithTransitionParams;
export type ThreadLifecycleCommandResult = UpdateThreadChatWithTransitionResult;

export async function transitionThreadChatLifecycle(
  input: ThreadLifecycleCommandInput,
): Promise<ThreadLifecycleCommandResult> {
  return updateThreadChatWithTransition(input);
}
