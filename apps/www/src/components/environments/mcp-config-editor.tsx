"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { McpConfig, validateMcpConfig } from "@terragon/sandbox/mcp-config";

interface McpConfigEditorProps {
  value: McpConfig;
  onChange: (config: McpConfig) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  disabled?: boolean;
}

export function McpConfigEditor({
  value,
  onChange,
  onDirtyChange,
  disabled,
}: McpConfigEditorProps) {
  const [configText, setConfigText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    // Initialize the text with the current value
    if (value && Object.keys(value.mcpServers).length > 0) {
      setConfigText(JSON.stringify(value, null, 2));
    }
  }, [value]);

  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setConfigText(newText);
      setIsDirty(true);
      setError(null);

      // Try to parse and validate the JSON
      if (newText.trim()) {
        try {
          const parsed = JSON.parse(newText);
          const validationResult = validateMcpConfig(parsed);
          if (!validationResult.success) {
            setError(validationResult.error);
          }
        } catch (e) {
          setError("Invalid JSON format");
        }
      }
    },
    [],
  );

  const handleSave = useCallback(() => {
    if (!configText.trim()) {
      // Empty config means no custom MCP servers
      onChange({ mcpServers: {} });
      setIsDirty(false);
      return;
    }

    try {
      const parsed = JSON.parse(configText);
      const validationResult = validateMcpConfig(parsed);

      if (!validationResult.success) {
        setError(validationResult.error);
        return;
      }

      onChange(validationResult.data);
      setIsDirty(false);
      setError(null);
    } catch (e) {
      setError("Invalid JSON format");
    }
  }, [configText, onChange]);

  const handleReset = useCallback(() => {
    if (value && Object.keys(value.mcpServers).length > 0) {
      setConfigText(JSON.stringify(value, null, 2));
    } else {
      setConfigText("");
    }
    setError(null);
    setIsDirty(false);
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Textarea
          value={configText}
          onChange={handleTextChange}
          placeholder={`Enter your MCP JSON config here…`}
          className={cn(
            "font-mono text-[13px] leading-[1.5] min-h-[220px] rounded-xl border-0 ring-0 bg-surface-dark text-on-dark caret-coral placeholder:text-on-dark-soft focus-visible:ring-2 focus-visible:ring-coral/50",
            error && "ring-2 ring-error/40 focus-visible:ring-error/60",
          )}
          disabled={disabled}
        />
        <p className="min-h-4 mt-1 flex items-center gap-1 text-xs text-error">
          {error && (
            <>
              <AlertCircle className="h-3 w-3" />
              {error}
            </>
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={disabled || !isDirty || !!error}
        >
          <Check className="h-3 w-3 mr-1" />
          Save MCP config
        </Button>
        {isDirty && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={disabled}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
