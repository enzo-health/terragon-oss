/**
 * Lazy loader for the KaTeX-powered math plugin.
 *
 * The upstream `@streamdown/math` package transitively pulls in `rehype-katex`,
 * `remark-math`, and the full `katex` library (~284 KB of JS). KaTeX also ships
 * a 280 KB stylesheet. Most chat responses never contain math, so paying that
 * cost on every chat-page paint is wasteful.
 *
 * This module is dynamic-imported by `markdown-renderer.tsx` only when the
 * current `content` string actually contains math delimiters. The heavy
 * dependencies and the KaTeX CSS are sideloaded together so the style
 * correctly attaches once the plugin is active.
 */
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";

export { createMathPlugin };
