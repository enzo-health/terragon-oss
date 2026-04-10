import { Calendar, GitPullRequest, CircleDot } from "lucide-react";
import {
  AutomationTriggerType,
  ScheduleTriggerConfig,
  PullRequestTriggerConfig,
  IssueTriggerConfig,
} from "@leo/shared/automations";

export interface RecommendedAutomation {
  id: string;
  label: string;
  prompt: string;
  triggerType: AutomationTriggerType;
  icon: React.ReactNode;
  triggerConfig:
    | ScheduleTriggerConfig
    | PullRequestTriggerConfig
    | IssueTriggerConfig;
}

export const RECOMMENDED_AUTOMATIONS: RecommendedAutomation[] = [
  {
    id: "daily-overview-commits",
    label: "Daily overview of commits",
    prompt:
      "Give me an overview of all of the commits made yesterday to the repo, organized by the user who made the commit. On Mondays, provide an overview of all the commits made between Friday - Sunday.\n\nUse this format:\n\n[User]:\n- [Summary of commit] [PR #:] [detailed description of changes]",
    triggerType: "schedule",
    icon: <Calendar className="size-3 text-muted-foreground/50" />,
    triggerConfig: {
      cron: "0 8 * * 1-5", // 8 AM on weekdays (Monday-Friday)
      timezone: "America/Los_Angeles",
    } as ScheduleTriggerConfig,
  },
  {
    id: "code-review",
    label: "Code review",
    prompt: `You are an expert code reviewer. Follow these steps:
1. Use gh pr view {PR number} to get PR details
2. Use gh pr diff {PR number} to get the diff
3. Analyze the changes and provide a thorough code review that includes:
  - Overview of what the PR does
  - Analysis of code quality and style
  - Specific suggestions for improvements
  - Any potential issues or risks

Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations

When you're done with your review, create a single comment directly on the PR that summarizes the review and for any recommended changes leave in-line review with the relevant parts of the code highlighted. Format your comments with clear sections and bullet points.`,
    triggerType: "pull_request",
    icon: <GitPullRequest className="size-3 text-muted-foreground/50" />,
    triggerConfig: {
      filter: {
        includeDraftPRs: true,
        includeOtherAuthors: false,
      },
      on: {
        open: true,
        update: false,
      },
      autoArchiveOnComplete: true,
    } as PullRequestTriggerConfig,
  },
  {
    id: "issue-triage",
    label: "Issue triage",
    prompt: `You're an issue triage assistant for GitHub issues. Your task is to analyze the issue and select appropriate labels from the provided list.

IMPORTANT: Don't post any comments or messages to the issue. Your only action should be to apply labels.

TASK OVERVIEW:
1. First, fetch the list of labels available in this repository by running: \`gh label list\`. Run exactly this command with nothing else.
2. Next, use the GitHub CLI to get context about the issue:
  - Use \`gh issue view {{issue_number}} --json title,body,labels,state\` to retrieve the current issue's details
  - Use \`gh issue view {{issue_number}} --comments\` to read any discussion or additional context provided in the comments
  - Use \`gh issue list --search "{{search_terms}}"\` to find similar issues that might provide context for proper categorization and to identify potential duplicate issues
  - Use \`gh issue list --label "{{label_name}}"\` to understand patterns in how other issues are labeled

3. Analyze the issue content, considering:
  - The issue title and description
  - The type of issue (bug report, feature request, question, etc.)
  - Technical areas mentioned
  - Severity or priority indicators
  - User impact
  - Components affected

4. Select appropriate labels from the available labels list provided above:
  - Choose labels that accurately reflect the issue's nature
  - Be specific but comprehensive
  - Select priority labels if you can determine urgency (high-priority, med-priority, or low-priority)
  - Consider platform labels (android, ios) if applicable
  - If you find similar issues using \`gh issue list --search\`, consider using a "duplicate" label if appropriate. Only do so if the issue is a duplicate of another OPEN issue.

5. Apply the selected labels:
  - Use \`gh issue edit {{issue_number}} --add-label "{{label1}},{{label2}},{{label3}}"\` to apply the labels
  - DO NOT post any comments explaining your decision
  - DO NOT communicate directly with users
  - If no labels are clearly applicable, do not apply any labels

IMPORTANT GUIDELINES:
- Be thorough in your analysis
- Only select labels from the provided list above
- DO NOT post any comments to the issue
- Your ONLY action should be to apply labels using \`gh issue edit --add-label\`
- It's okay to not add any labels if none are clearly applicable`,
    triggerType: "issue",
    icon: <CircleDot className="size-3 text-muted-foreground/50" />,
    triggerConfig: {
      filter: {
        includeOtherAuthors: false,
      },
      on: {
        open: true,
      },
      autoArchiveOnComplete: true,
    } as IssueTriggerConfig,
  },
];
