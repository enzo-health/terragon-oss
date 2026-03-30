/**
 * QA Command for Terry CLI
 *
 * Usage:
 *   terry qa verify <thread-id>     - Validate a thread's consistency
 *   terry qa watch <thread-id>      - Continuous validation with polling
 *   terry qa create                 - Create task with validation (future)
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { createValidator } from "../qa/validator.js";
import type { ValidationResult, Discrepancy } from "../qa/types.js";

interface QACommandProps {
  command: "verify" | "watch" | "report";
  threadId?: string;
  options: {
    deep?: boolean;
    json?: boolean;
    pollInterval?: number;
    timeout?: number;
    failOnDiscrepancy?: boolean;
  };
}

export function QACommand({ command, threadId, options }: QACommandProps) {
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pollCount, setPollCount] = useState(0);

  useEffect(() => {
    if (command === "verify" && threadId) {
      runOnce(threadId);
    } else if (command === "watch" && threadId) {
      runWatch(
        threadId,
        options.pollInterval || 30000,
        options.timeout || 600000,
      );
    } else if (command === "report" && threadId) {
      runReport(threadId);
    } else {
      setError(
        "Missing required arguments. Usage: terry qa <verify|watch|report> <thread-id>",
      );
      setIsLoading(false);
    }
  }, [command, threadId]);

  async function runOnce(id: string): Promise<void> {
    try {
      setIsLoading(true);

      const validator = await createValidator({
        threadId: id,
        includeUI: true,
        includeDatabase: true,
        includeContainer: true,
        timeoutMs: options.timeout || 30000,
        deepMode: options.deep || false,
      });

      const validationResult = await validator.validate();
      setResult(validationResult);

      if (options.json) {
        console.log(JSON.stringify(validationResult, null, 2));
      }

      // Exit with error code if failOnDiscrepancy and issues found
      if (options.failOnDiscrepancy && !validationResult.isHealthy) {
        process.exitCode = 1;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  async function runWatch(
    id: string,
    intervalMs: number,
    timeoutMs: number,
  ): Promise<void> {
    const startTime = Date.now();
    const results: ValidationResult[] = [];

    try {
      while (Date.now() - startTime < timeoutMs) {
        setPollCount((c) => c + 1);

        const validator = await createValidator({
          threadId: id,
          includeUI: true,
          includeDatabase: true,
          includeContainer: true,
          timeoutMs: 30000,
          deepMode: false,
        });

        const validationResult = await validator.validate();
        results.push(validationResult);
        setResult(validationResult);

        // Stop if critical discrepancies found
        if (
          validationResult.summary.criticalCount > 0 &&
          options.failOnDiscrepancy
        ) {
          setIsLoading(false);
          return;
        }

        // Wait for next poll
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  async function runReport(id: string): Promise<void> {
    // Generate detailed report (JSON output for now)
    await runOnce(id);
  }

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text>
          <Spinner type="dots" />{" "}
          {command === "watch"
            ? `Watching thread ${threadId} (poll #${pollCount})...`
            : `Validating thread ${threadId}...`}
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">❌ Error: {error}</Text>
      </Box>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Text color={result.isHealthy ? "green" : "red"}>
        {result.isHealthy ? "✅" : "❌"}{" "}
        {result.isHealthy ? "HEALTHY" : "UNHEALTHY"}
      </Text>

      <Text dimColor>
        Thread: {result.threadId} | Duration: {result.durationMs}ms | Verified:{" "}
        {result.verifiedAt.toISOString()}
      </Text>

      <Box marginTop={1}>
        <Text>Sources checked: {Object.keys(result.sources).join(", ")}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>Discrepancies: {result.summary.totalCount} total</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text color="red">🔴 Critical: {result.summary.criticalCount}</Text>
        <Text color="yellow">🟡 Warning: {result.summary.warningCount}</Text>
        <Text color="blue">🔵 Info: {result.summary.infoCount}</Text>
      </Box>

      {result.discrepancies.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Issues found:</Text>
          {result.discrepancies.map((d) => (
            <DiscrepancyRow key={d.id} discrepancy={d} />
          ))}
        </Box>
      )}

      {result.summary.criticalCount === 0 &&
        result.summary.warningCount === 0 && (
          <Box marginTop={1}>
            <Text color="green">✅ All validation rules passed</Text>
          </Box>
        )}
    </Box>
  );
}

function DiscrepancyRow({ discrepancy: d }: { discrepancy: Discrepancy }) {
  const color =
    d.severity === "critical"
      ? "red"
      : d.severity === "warning"
        ? "yellow"
        : "blue";
  const icon =
    d.severity === "critical" ? "🔴" : d.severity === "warning" ? "🟡" : "🔵";

  return (
    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text color={color}>
        {icon} [{d.severity.toUpperCase()}] {d.type}
      </Text>
      <Text dimColor>Field: {d.field}</Text>
      <Text>{d.description}</Text>
      <Text dimColor>Impact: {d.impact}</Text>
      {d.recommendedFix && <Text color="cyan">Fix: {d.recommendedFix}</Text>}
    </Box>
  );
}
