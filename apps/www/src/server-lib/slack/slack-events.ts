export interface SlackAppMentionEvent {
  type: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  slackEventId?: string;
  team?: string;
  enterprise?: string;
  channel_team?: string;
  source_team?: string;
  files?: unknown[];
  edited?: {
    user: string;
    ts: string;
  };
}

export interface SlackInteractiveAction {
  action_id: string;
  value: string;
  type: string;
}
