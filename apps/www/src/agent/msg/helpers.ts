// The recoverable-failure parsers moved to @terragon/agent so the daemon can
// import them to stamp typed classifications onto canonical run-terminals (K2).
// Re-exported here so existing www call sites (message-parser.ts, tests) keep
// working. Wave 4 deletes the message-sniffing consumers that depend on these.
export {
  type RecoverableParseMessage,
  parseClaudeRateLimitMessageStr,
  parseClaudeRateLimitMessage,
  parseClaudeOverloadedMessage,
  parseClaudePromptTooLongMessage,
  parseContextWindowExhausted,
  parseCodexErrorMessage,
  parseCodexRateLimitMessageStr,
  parseCodexRateLimitMessage,
  parseClaudeOAuthTokenRevokedMessage,
  classifyRecoverableTerminal,
} from "@terragon/agent/recoverable-terminal";
