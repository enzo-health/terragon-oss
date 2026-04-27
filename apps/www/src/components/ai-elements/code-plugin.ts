/**
 * Local, tree-shakeable drop-in replacement for `@streamdown/code`'s `createCodePlugin`.
 *
 * The upstream `@streamdown/code` package does `import { bundledLanguages, bundledLanguagesInfo,
 * createHighlighter } from "shiki"` at module scope. Those indexes reference all 140+ grammars and
 * all themes via dynamic `import()` callbacks, so the bundler cannot tree-shake them — every
 * grammar and theme ends up in the client bundle (~9.4 MiB of grammars + 1.3 MiB of themes +
 * 623 KiB of oniguruma WASM).
 *
 * This plugin:
 *  - Imports `createHighlighterCore` from `@shikijs/core` (no bundled-indexes side effects)
 *  - Uses the JavaScript regex engine (no oniguruma WASM)
 *  - Statically imports only a curated set of ~20 languages and 2 themes via `shiki/langs/*.mjs`
 *    and `shiki/themes/*.mjs` — each a single grammar/theme JSON module the bundler CAN tree-shake
 *  - Preserves the streaming cache + promise-coalescing semantics of the upstream plugin so
 *    Streamdown's streaming code-highlighting UX is unchanged.
 */
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterCore,
  LanguageRegistration,
  ThemeRegistrationRaw,
  TokensResult,
} from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import githubLight from "shiki/themes/github-light.mjs";
import oneDarkPro from "shiki/themes/one-dark-pro.mjs";

import bashLang from "shiki/langs/bash.mjs";
import cLang from "shiki/langs/c.mjs";
import cppLang from "shiki/langs/cpp.mjs";
import csharpLang from "shiki/langs/csharp.mjs";
import cssLang from "shiki/langs/css.mjs";
import diffLang from "shiki/langs/diff.mjs";
import dockerfileLang from "shiki/langs/dockerfile.mjs";
import goLang from "shiki/langs/go.mjs";
import htmlLang from "shiki/langs/html.mjs";
import javaLang from "shiki/langs/java.mjs";
import javascriptLang from "shiki/langs/javascript.mjs";
import jsonLang from "shiki/langs/json.mjs";
import jsxLang from "shiki/langs/jsx.mjs";
import markdownLang from "shiki/langs/markdown.mjs";
import pythonLang from "shiki/langs/python.mjs";
import regexLang from "shiki/langs/regex.mjs";
import rustLang from "shiki/langs/rust.mjs";
import scssLang from "shiki/langs/scss.mjs";
import shellscriptLang from "shiki/langs/shellscript.mjs";
import sqlLang from "shiki/langs/sql.mjs";
import tomlLang from "shiki/langs/toml.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import typescriptLang from "shiki/langs/typescript.mjs";
import yamlLang from "shiki/langs/yaml.mjs";

// `shiki/themes/*.mjs` and `shiki/langs/*.mjs` re-export `@shikijs/themes|langs/*` whose default
// export is the theme/language registration object(s). Shape of each grammar module is
// `LanguageRegistration[]` and themes are `ThemeRegistrationRaw`.
const THEMES: Record<string, ThemeRegistrationRaw> = {
  "github-light": githubLight as unknown as ThemeRegistrationRaw,
  "one-dark-pro": oneDarkPro as unknown as ThemeRegistrationRaw,
};

// Map of canonical id -> grammar registration array. Aliases (ts, js, py, sh, md, yml, regexp)
// are resolved via `ALIAS_MAP` below before lookup.
const LANGS: Record<string, LanguageRegistration[]> = {
  bash: bashLang as unknown as LanguageRegistration[],
  c: cLang as unknown as LanguageRegistration[],
  cpp: cppLang as unknown as LanguageRegistration[],
  csharp: csharpLang as unknown as LanguageRegistration[],
  css: cssLang as unknown as LanguageRegistration[],
  diff: diffLang as unknown as LanguageRegistration[],
  dockerfile: dockerfileLang as unknown as LanguageRegistration[],
  go: goLang as unknown as LanguageRegistration[],
  html: htmlLang as unknown as LanguageRegistration[],
  java: javaLang as unknown as LanguageRegistration[],
  javascript: javascriptLang as unknown as LanguageRegistration[],
  json: jsonLang as unknown as LanguageRegistration[],
  jsx: jsxLang as unknown as LanguageRegistration[],
  markdown: markdownLang as unknown as LanguageRegistration[],
  python: pythonLang as unknown as LanguageRegistration[],
  regex: regexLang as unknown as LanguageRegistration[],
  rust: rustLang as unknown as LanguageRegistration[],
  scss: scssLang as unknown as LanguageRegistration[],
  shellscript: shellscriptLang as unknown as LanguageRegistration[],
  sql: sqlLang as unknown as LanguageRegistration[],
  toml: tomlLang as unknown as LanguageRegistration[],
  tsx: tsxLang as unknown as LanguageRegistration[],
  typescript: typescriptLang as unknown as LanguageRegistration[],
  yaml: yamlLang as unknown as LanguageRegistration[],
};

// Common aliases that `@streamdown/code` used to resolve via `bundledLanguagesInfo` — we hardcode
// the subset relevant to our curated grammars here to preserve "language: 'ts'" -> typescript etc.
const ALIAS_MAP: Record<string, string> = {
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  md: "markdown",
  yml: "yaml",
  regexp: "regex",
  // c++ is not a valid identifier for language-<name> class but handle it anyway
  "c++": "cpp",
  // common csharp aliases
  "c#": "csharp",
  cs: "csharp",
  // python alias
  py: "python",
  // dockerfile alias
  docker: "dockerfile",
};

const SUPPORTED_IDS: ReadonlySet<string> = new Set(Object.keys(LANGS));

function resolveLanguageId(language: string): string {
  const normalized = language.trim().toLowerCase();
  return ALIAS_MAP[normalized] ?? normalized;
}

const engine = createJavaScriptRegexEngine({ forgiving: true });

// Cache of highlighters keyed by `${langId}-${theme0}-${theme1}` matching the upstream semantics
// so the plugin lazily instantiates one small highlighter per (lang, theme-pair) combination.
const highlighterPromises = new Map<string, Promise<HighlighterCore>>();
const resultCache = new Map<string, TokensResult>();
const pendingCallbacks = new Map<string, Set<(result: TokensResult) => void>>();

function highlighterCacheKey(langId: string, themes: [string, string]): string {
  return `${langId}-${themes[0]}-${themes[1]}`;
}

function resultCacheKey(
  code: string,
  langId: string,
  themes: [string, string],
): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : "";
  return `${langId}:${themes[0]}:${themes[1]}:${code.length}:${head}:${tail}`;
}

function getHighlighter(
  langId: string,
  themes: [string, string],
): Promise<HighlighterCore> {
  const key = highlighterCacheKey(langId, themes);
  const existing = highlighterPromises.get(key);
  if (existing) return existing;

  const langRegistration = LANGS[langId];
  const themeRegistrations = themes
    .map((t) => THEMES[t])
    .filter((t): t is ThemeRegistrationRaw => t !== undefined);

  const promise = createHighlighterCore({
    engine,
    themes: themeRegistrations,
    langs: langRegistration ? [langRegistration] : [],
  });
  highlighterPromises.set(key, promise);
  return promise;
}

export type CodePluginOptions = {
  themes?: [BundledTheme, BundledTheme];
};

export type CodeHighlighterPluginShape = {
  name: "shiki";
  type: "code-highlighter";
  supportsLanguage: (language: BundledLanguage) => boolean;
  getSupportedLanguages: () => BundledLanguage[];
  getThemes: () => [BundledTheme, BundledTheme];
  highlight: (
    options: {
      code: string;
      language: BundledLanguage;
      themes: [string, string];
    },
    callback?: (result: TokensResult) => void,
  ) => TokensResult | null;
};

export function createCodePlugin(
  options: CodePluginOptions = {},
): CodeHighlighterPluginShape {
  const themes: [BundledTheme, BundledTheme] = options.themes ?? [
    "github-light",
    "one-dark-pro",
  ];

  return {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage(language: BundledLanguage): boolean {
      return SUPPORTED_IDS.has(resolveLanguageId(language));
    },
    getSupportedLanguages(): BundledLanguage[] {
      return Array.from(SUPPORTED_IDS) as BundledLanguage[];
    },
    getThemes(): [BundledTheme, BundledTheme] {
      return themes;
    },
    highlight({ code, language, themes: highlightThemes }, callback) {
      const langId = resolveLanguageId(language);
      const cacheKey = resultCacheKey(code, langId, highlightThemes);
      const cached = resultCache.get(cacheKey);
      if (cached) return cached;

      if (callback) {
        let callbacks = pendingCallbacks.get(cacheKey);
        if (!callbacks) {
          callbacks = new Set();
          pendingCallbacks.set(cacheKey, callbacks);
        }
        callbacks.add(callback);
      }

      getHighlighter(langId, highlightThemes)
        .then((highlighter) => {
          const loaded = highlighter.getLoadedLanguages();
          const effectiveLang = loaded.includes(langId) ? langId : "text";
          const tokens = highlighter.codeToTokens(code, {
            lang: effectiveLang,
            themes: { light: highlightThemes[0], dark: highlightThemes[1] },
          });
          resultCache.set(cacheKey, tokens);
          const callbacks = pendingCallbacks.get(cacheKey);
          if (callbacks) {
            for (const cb of callbacks) cb(tokens);
            pendingCallbacks.delete(cacheKey);
          }
        })
        .catch((err: unknown) => {
          // Match upstream: log and drop pending callbacks for this key.
          // eslint-disable-next-line no-console
          console.error("[code-plugin] Failed to highlight code:", err);
          pendingCallbacks.delete(cacheKey);
        });

      return null;
    },
  };
}
