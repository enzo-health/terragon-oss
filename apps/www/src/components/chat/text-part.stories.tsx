import type { Story, StoryDefault } from "@ladle/react";
import { TextPart } from "./text-part";

export default {
  title: "Chat/TextPart",
} satisfies StoryDefault;

export const SimpleText: Story = () => {
  return (
    <div className="p-4 max-w-4xl">
      <TextPart text="This is a simple text message without any markdown formatting." />
    </div>
  );
};

export const BasicMarkdown: Story = () => {
  const text = `# Heading 1
## Heading 2
### Heading 3

This is a paragraph with **bold text** and *italic text*.

Here's a [link to Google](https://google.com).

- First item
- Second item
- Third item

1. Numbered item one
2. Numbered item two
3. Numbered item three`;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const CodeBlocks: Story = () => {
  const text = `Here's some inline code: \`const foo = "bar"\`.

And here's a code block with language:

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet("World");
\`\`\`

And a code block without language specification:

\`\`\`
packages/sandbox/
├── package.json  # Package configuration
├── tsconfig.json  # TypeScript config
├── vitest.config.ts  # Test configuration
├── README.md  # Documentation
└── src/
    ├── index.ts  # Main exports
    ├── interfaces.ts  # Core interfaces
    └── providers/  # Provider implementations
\`\`\``;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const MultipleLanguages: Story = () => {
  const text = `## Multiple Programming Languages

### TypeScript
\`\`\`typescript
interface User {
  id: string;
  name: string;
  email: string;
}

const getUser = async (id: string): Promise<User> => {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
};
\`\`\`

### Python
\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

# Example usage
print([fibonacci(i) for i in range(10)])
\`\`\`

### SQL
\`\`\`sql
SELECT 
    u.name,
    COUNT(o.id) as order_count,
    SUM(o.total) as total_spent
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 5
ORDER BY total_spent DESC;
\`\`\``;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const Tables: Story = () => {
  const text = `## GitHub Flavored Markdown Table

| Feature | Status | Priority |
|---------|--------|----------|
| Authentication | ✅ Complete | High |
| Dashboard | 🚧 In Progress | High |
| Settings | ⏳ Planned | Medium |
| Analytics | 💡 Idea | Low |

### Complex Table

| Language | Type | Paradigm | Popular Frameworks |
|----------|------|----------|-------------------|
| JavaScript | Dynamic | Multi-paradigm | React, Vue, Angular |
| TypeScript | Static | OOP/Functional | Same as JS + type safety |
| Python | Dynamic | Multi-paradigm | Django, Flask, FastAPI |
| Rust | Static | Systems | Actix, Rocket, Tokio |
| Go | Static | Procedural | Gin, Echo, Fiber |`;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const Blockquotes: Story = () => {
  const text = `## Blockquotes Example

> This is a simple blockquote.

> This is a multi-line blockquote.
> It can span multiple lines and maintain formatting.
> 
> It can even have multiple paragraphs.

### Nested Elements in Blockquotes

> **Note:** Blockquotes can contain other markdown elements.
> 
> - Like lists
> - With multiple items
> 
> \`\`\`javascript
> // Even code blocks
> console.log("Hello from blockquote!");
> \`\`\``;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const MixedContent: Story = () => {
  const text = `# Project Documentation

## Overview

This project implements a **markdown renderer** with support for various elements. It includes:

1. **Text formatting** - Bold, italic, and \`inline code\`
2. **Code blocks** - With syntax highlighting
3. **Lists** - Both ordered and unordered
4. **Tables** - GitHub-flavored markdown tables
5. **Links** - [External](https://example.com) and internal references

## Installation

\`\`\`bash
npm install streamdown @streamdown/code
\`\`\`

## Usage Example

\`\`\`tsx
import { TextPart } from './text-part';

function MyComponent() {
  return <TextPart text="# Hello World" />;
}
\`\`\`

## API Reference

| Prop | Type | Description | Required |
|------|------|-------------|----------|
| text | string | Markdown text to render | Yes |

> **Note:** This component uses \`streamdown\` with \`@streamdown/code\` for markdown rendering and syntax highlighting.

## File Structure

\`\`\`
src/
├── components/
│   └── chat/
│       ├── text-part.tsx
│       └── text-part.stories.tsx
└── styles/
    └── globals.css
\`\`\`

### Todo List

- [x] Basic markdown support
- [x] Syntax highlighting
- [x] GFM tables
- [ ] Copy code button
- [ ] Line numbers option`;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const EdgeCases: Story = () => {
  const text = `## Edge Cases

### Empty Code Block
\`\`\`
\`\`\`

### Code Block with Extra Backticks
\`\`\`\`javascript
// This has 4 backticks
const test = "should still work";
\`\`\`\`

### Very Long Inline Code
Here's some very long inline code that might wrap: \`const veryLongVariableNameThatMightCauseWrappingIssues = "This is a very long string value that definitely will cause wrapping in most viewport sizes";\`

### Special Characters in Code
\`\`\`javascript
const regex = /\\d{3}-\\d{3}-\\d{4}/; // Phone number regex
const template = \`Hello, \${name}! <script>alert('XSS')</script>\`;
const escaped = "Line 1\\nLine 2\\tTabbed";
\`\`\`

### Unicode and Emojis
- 🚀 Rocket launch
- 📝 Documentation
- ✅ Complete
- ❌ Failed
- 🔧 In progress

### Long Unbreakable Text
Verylongwordthatdoesnthavenaturalbreakpointsandmightcauselayoutissuesifnothandledproperlybythetextcomponent`;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const RealWorldExample: Story = () => {
  const text = `## API Response Handler

I've implemented the error handling for the API responses. Here's what changed:

### Changes Made

1. **Added comprehensive error handling** in \`src/api/handler.ts:42\`
2. **Updated response types** to include error states
3. **Added retry logic** for transient failures

### Implementation Details

\`\`\`typescript
export async function apiRequest<T>(
  endpoint: string,
  options?: RequestOptions
): Promise<ApiResponse<T>> {
  const maxRetries = options?.retries ?? 3;
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });
      
      if (!response.ok) {
        throw new ApiError(response.status, await response.text());
      }
      
      return {
        success: true,
        data: await response.json(),
      };
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry on client errors
      if (error instanceof ApiError && error.status < 500) {
        break;
      }
      
      // Exponential backoff
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  
  return {
    success: false,
    error: lastError?.message ?? 'Unknown error',
  };
}
\`\`\`

### Test Results

| Test Case | Status | Time (ms) |
|-----------|--------|-----------|
| Success response | ✅ Pass | 45 |
| 404 error | ✅ Pass | 12 |
| 500 with retry | ✅ Pass | 3024 |
| Network timeout | ✅ Pass | 5001 |

> **Note:** All tests are passing. The retry logic adds ~3s for server errors due to exponential backoff.

### Next Steps

- [ ] Add request cancellation support
- [ ] Implement response caching
- [ ] Add request/response interceptors`;

  return (
    <div className="p-4 max-w-4xl">
      <TextPart text={text} />
    </div>
  );
};

export const DarkModeCompatibility: Story = () => {
  const text = `# Dark Mode Test

This story tests how the component looks in dark mode.

## Code Highlighting

\`\`\`javascript
// The syntax highlighter should work well in both themes
const theme = isDarkMode ? 'dark' : 'light';
document.body.className = theme;
\`\`\`

## Inline Elements

Regular text with \`inline code\`, **bold**, and *italic* formatting.

> Blockquote styling should be visible in both themes

| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

  return (
    <div className="p-4 max-w-4xl">
      <div className="space-y-8">
        <div className="p-4 rounded-lg bg-background">
          <h3 className="text-sm font-medium mb-2 text-muted-foreground">
            Light Mode
          </h3>
          <TextPart text={text} />
        </div>
        <div className="p-4 rounded-lg bg-background dark">
          <h3 className="text-sm font-medium mb-2 text-muted-foreground">
            Dark Mode
          </h3>
          <TextPart text={text} />
        </div>
      </div>
    </div>
  );
};

export const WithCitations: Story = () => {
  const text = `# Code Citations Example

Here's how we handle code citations in our codebase:

## Basic Citations

- Check the configuration at 【F:vitest.config.ts†L1-L6】
- See the main documentation in 【F:README.md†L1】
- The implementation details are in 【F:src/components/Button.tsx†L42-L50】

## Single Line References

You can also reference single lines like 【F:package.json†L10】 or multiple files:
- 【F:src/index.ts†L1-L20】
- 【F:src/utils/helpers.ts†L5】

## Citations in Context

The error handling logic 【F:src/api/handler.ts†L42】 works together with the retry mechanism
defined in 【F:src/api/retry.ts†L15-L25】. These components ensure robust API communication.

> **Note:** Citations link to the current branch if a checkpoint exists, otherwise to the base branch.`;

  return (
    <div className="p-4 max-w-4xl space-y-8">
      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
          Without GitHub context:
        </h3>
        <div className="border rounded-lg p-4">
          <TextPart text={text} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
          No checkpoint (links to base branch 'main'):
        </h3>
        <div className="border rounded-lg p-4">
          <TextPart
            text={text}
            githubRepoFullName="terragon/terragon"
            baseBranchName="main"
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
          With checkpoint (links to feature branch):
        </h3>
        <div className="border rounded-lg p-4">
          <TextPart
            text={text}
            githubRepoFullName="terragon/terragon"
            branchName="feature/new-feature"
            baseBranchName="main"
            hasCheckpoint={true}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
          Branch created but no checkpoint yet (links to base branch):
        </h3>
        <div className="border rounded-lg p-4">
          <TextPart
            text={text}
            githubRepoFullName="terragon/terragon"
            branchName="feature/new-feature"
            baseBranchName="main"
            hasCheckpoint={false}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
          Custom base branch, no checkpoint:
        </h3>
        <div className="border rounded-lg p-4">
          <TextPart
            text={text}
            githubRepoFullName="terragon/terragon"
            baseBranchName="develop"
          />
        </div>
      </div>
    </div>
  );
};
