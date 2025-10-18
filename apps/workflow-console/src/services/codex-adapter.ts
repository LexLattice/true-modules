import type {
  CodexPrompt,
  CodexSuggestion,
  CodexStreamHandle,
  CodexSuggestionStream,
  CodexPublishReceipt,
} from '../types/canon';
import { HistoryStore } from './history-store';
import { createEmitter } from './emitter';
import { TelemetryHub } from './telemetry';

/**
 * CodexAdapter emits lightweight deterministic suggestions and records the
 * interaction for audits via the HistoryStore.
 */
export class CodexAdapter {
  constructor(
    private history: HistoryStore,
    private telemetry: TelemetryHub,
  ) {}

  generate(prompt: CodexPrompt): CodexStreamHandle {
    if (!['draft_brief', 'draft_requirement', 'draft_note'].includes(prompt.intent)) {
      throw new Error(
        `E_INPUT_GUARD: invalid intent ${prompt.intent}`,
      );
    }
    if (/forbidden|breach/gi.test(prompt.input)) {
      throw new Error('E_POLICY_GUARD');
    }
    const stream: CodexSuggestionStream = {
      suggestions: [],
      finalized: false,
    };
    const emitter = createEmitter<CodexSuggestionStream>();
    const base: CodexSuggestion = {
      id: `${prompt.intent}-${Date.now()}`,
      content: this.buildContent(prompt),
      tokens: Math.max(12, Math.ceil(prompt.input.length / 3)),
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const push = (payload: CodexSuggestionStream) => {
      stream.suggestions = payload.suggestions.map((suggestion) => ({ ...suggestion }));
      stream.finalized = payload.finalized;
      emitter.emit({ ...stream, suggestions: [...stream.suggestions] });
      this.telemetry.track('codex', 'codex.stream', {
        sessionId: prompt.sessionId,
        finalized: stream.finalized,
        suggestions: stream.suggestions.length,
      });
    };
    push({ suggestions: [], finalized: false });
    timers.push(
      setTimeout(() => {
        push({
          suggestions: [
            {
              ...base,
              content: `${base.content}\n\nDrafting response…`,
            },
          ],
          finalized: false,
        });
      }, 120),
    );
    timers.push(
      setTimeout(() => {
        push({
          suggestions: [
            base,
            {
              ...base,
              id: `${base.id}-alt`,
              content: `${base.content}\n\nAlternate angle.`,
              redacted: true,
            },
          ],
          finalized: true,
        });
      }, 300),
    );
    return {
      stream,
      subscribe(listener) {
        listener({ ...stream, suggestions: [...stream.suggestions] });
        return emitter.subscribe((snapshot) => {
          listener({ ...snapshot, suggestions: [...snapshot.suggestions] });
        });
      },
      redact: () => {
        stream.suggestions = stream.suggestions.map((suggestion) => ({
          ...suggestion,
          content: suggestion.content.replace(/(secret|token)/gi, '[redacted]'),
          redacted: true,
        }));
        stream.finalized = true;
        emitter.emit({ ...stream, suggestions: [...stream.suggestions] });
        return { ...stream, suggestions: [...stream.suggestions] };
      },
      publishDraft: (): CodexPublishReceipt => {
        const primary = stream.suggestions[0] ?? base;
        const auditId = this.history.recordCodexAudit(prompt, primary);
        this.telemetry.track('codex', 'codex.publish', {
          auditId,
          sessionId: prompt.sessionId,
        });
        timers.forEach((timer) => clearTimeout(timer));
        return { auditId, saved: true };
      },
    };
  }

  redact(content: string): string {
    return content.replace(/(secret|token)/gi, '[redacted]');
  }

  private buildContent(prompt: CodexPrompt): string {
    const cleaned = this.redact(prompt.input.trim());
    switch (prompt.intent) {
      case 'draft_brief':
        return `Brief draft based on input: ${cleaned}`;
      case 'draft_requirement':
        return `Requirement outline: ${cleaned}`;
      case 'draft_note':
      default:
        return `Operator note: ${cleaned}`;
    }
  }
}
