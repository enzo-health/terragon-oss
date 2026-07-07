import { applyAgUiEvent } from "./apply-ag-ui-event";
import {
  createInitialTranscriptState,
  type TranscriptEnvelope,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript-item";

export class TranscriptStore {
  private state: TranscriptState = createInitialTranscriptState();
  private readonly listeners = new Set<() => void>();

  apply(envelope: TranscriptEnvelope): void {
    const next = applyAgUiEvent(this.state, envelope);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  applyEvent(
    payload: TranscriptEnvelope["payload"],
    runId: string | null,
  ): void {
    this.apply({ payload, runId });
  }

  getState = (): TranscriptState => this.state;

  getItems = (): readonly TranscriptItem[] => this.state.items;

  getItem = (key: string): TranscriptItem | undefined => {
    const position = this.state.index[key];
    return position === undefined ? undefined : this.state.items[position];
  };

  getItemVersion = (key: string): number => this.state.versions[key] ?? 0;

  getRevision = (): number => this.state.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  reset(): void {
    this.state = createInitialTranscriptState();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
