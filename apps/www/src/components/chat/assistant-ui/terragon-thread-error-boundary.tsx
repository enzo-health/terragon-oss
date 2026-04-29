"use client";

import type { ThreadStatus } from "@terragon/shared";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ChatError } from "../chat-error";

type TerragonThreadErrorBoundaryProps = {
  threadStatus: ThreadStatus | null;
  isReadOnly?: boolean;
  children: ReactNode;
};

type TerragonThreadErrorBoundaryState = {
  error: Error | null;
};

export class TerragonThreadErrorBoundary extends Component<
  TerragonThreadErrorBoundaryProps,
  TerragonThreadErrorBoundaryState
> {
  state: TerragonThreadErrorBoundaryState = { error: null };

  static getDerivedStateFromError(
    error: Error,
  ): TerragonThreadErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("TerragonThread crashed:", error, info);
    if (typeof globalThis.reportError === "function") {
      globalThis.reportError(error);
    }
  }

  private handleRetry = async (): Promise<void> => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 mt-12 mb-8">
          <ChatError
            status={this.props.threadStatus ?? "error"}
            errorType="unknown-error"
            errorInfo={error.message || "The chat UI crashed unexpectedly."}
            handleRetry={this.handleRetry}
            isReadOnly={this.props.isReadOnly ?? false}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
