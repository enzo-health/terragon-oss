/**
 * Prompt engineering for AI code reviews.
 *
 * Two distinct prompts:
 * 1. Initial review — blind, fresh perspective with no prior bot context
 * 2. Re-review — followup check on whether prior comments were addressed
 */

export function buildReviewPrompt({
  prNumber,
  prTitle,
  prBaseBranch,
  repoFullName,
}: {
  prNumber: number;
  prTitle: string;
  prBaseBranch: string;
  repoFullName: string;
}): string {
  return `You are performing a code review of PR #${prNumber}: "${prTitle}" in ${repoFullName}.

Your task is to review ALL changed files compared to origin/${prBaseBranch}. This is a fresh, independent review — do not reference any prior reviews or bot feedback.

## Instructions

1. First, run \`git diff origin/${prBaseBranch}...HEAD --stat\` to see all changed files
2. Read and analyze every changed file thoroughly
3. Look for:
   - Logic errors and potential bugs
   - Security vulnerabilities
   - Performance issues
   - Pattern violations and inconsistencies with the codebase
   - Missing error handling for edge cases
   - Code that doesn't match the described intent

## Output Format

You MUST output your findings in the following structured format:

### SUMMARY
A 2-3 sentence overall assessment of the PR.

### CODE_CHANGE_SUMMARY
A technical summary of what the code changes actually do (not just the PR description).

### DONE_WELL
What was done well in this PR (1-3 bullet points).

### RISK_LEVEL
One of: LOW, MEDIUM, HIGH

### COMMENTS
Output each comment as a JSON block:

\`\`\`json
{
  "file": "path/to/file.ts",
  "line": 42,
  "priority": "HIGH",
  "body": "Description of the issue and suggested fix",
  "introducedByPr": true
}
\`\`\`

Priority levels:
- HIGH: Critical bugs, security issues, data loss risks
- MEDIUM: Logic issues, missing edge cases, significant code quality
- LOW: Style issues, minor improvements, suggestions

Set "introducedByPr" to true if the issue is in code modified by this PR, false if it's pre-existing code that was already there.

Output one JSON block per comment. Include at least the file path for every comment.`;
}

export function buildReReviewPrompt({
  prNumber,
  prBaseBranch,
  repoFullName,
  previousComments,
}: {
  prNumber: number;
  prBaseBranch: string;
  repoFullName: string;
  previousComments: Array<{
    file: string;
    line: number | null;
    body: string;
    priority: string;
  }>;
}): string {
  const commentsList = previousComments
    .map(
      (c, i) =>
        `${i + 1}. [${c.priority}] ${c.file}${c.line ? `:${c.line}` : ""}: ${c.body}`,
    )
    .join("\n");

  return `You are performing a follow-up review of PR #${prNumber} in ${repoFullName}.

Previously, we posted the following review comments requesting changes:

${commentsList}

The author has pushed new commits to address this feedback.

## Instructions

1. Run \`git log origin/${prBaseBranch}..HEAD --oneline\` to see all commits
2. For each previous comment, check:
   - Did the author make changes that address the feedback?
   - Is the fix correct and complete?
   - Did the fix introduce any new issues?

## Output Format

For each previous comment, output a resolution block:

\`\`\`json
{
  "commentIndex": 1,
  "resolution": "resolved",
  "note": "Fixed in commit abc123 — correctly handles the edge case now"
}
\`\`\`

Resolution values:
- "resolved" — Author addressed the feedback correctly
- "partially_resolved" — Author attempted to fix but the fix is incomplete
- "not_addressed" — No changes related to this feedback

Then, if you find any NEW issues introduced by the fixes, output them as COMMENTS blocks (same format as the initial review).

### NEW_COMMENTS
\`\`\`json
{
  "file": "path/to/file.ts",
  "line": 42,
  "priority": "HIGH",
  "body": "New issue introduced by the fix: ...",
  "introducedByPr": true
}
\`\`\``;
}
