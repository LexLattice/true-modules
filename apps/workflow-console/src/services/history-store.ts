import type {
  ArtifactSummary,
  CodexPrompt,
  CodexSuggestion,
  ConfigSubmission,
  HistoryList,
  HistoryQuery,
  HistoryReceipt,
  HistoryReplayRequest,
  HistoryView,
  RunDefaults,
  RunHistoryRecord,
} from '../types/canon';
import { RunStateGateway } from './run-state-gateway';
import { createEmitter } from './emitter';
import { TelemetryHub } from './telemetry';

/**
 * In-memory implementation of the history store. A real implementation would
 * persist to durable storage; this version keeps enough state for tests and
 * manual exploration.
 */
export class HistoryStore {
  private runs: RunHistoryRecord[] = [];
  private defaults = new Map<string, ConfigSubmission>();
  private codexAudit: Array<{
    id: string;
    prompt: CodexPrompt;
    suggestion: CodexSuggestion;
    timestamp: string;
  }> = [];
  private historyEmitter = createEmitter<void>();

  constructor(
    private runStateGateway: RunStateGateway,
    private telemetry: TelemetryHub,
  ) {}

  appendRun(record: RunHistoryRecord): HistoryReceipt {
    const existing = this.runs.find((item) => item.runId === record.runId);
    if (existing) {
      throw new Error(
        `E_DUPLICATE: run ${record.runId} already exists in history`,
      );
    }
    this.runs.push(record);
    this.historyEmitter.emit();
    this.telemetry.track('history', 'run.appended', {
      runId: record.runId,
      status: record.status,
    });
    return { saved: true, runId: record.runId };
  }

  loadHistory(query: HistoryQuery): HistoryList {
    if (!query.userId) {
      throw new Error('E_PERMISSION: userId is required to load history');
    }
    const items = this.runs
      .slice()
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, query.limit ?? 20);
    return { items };
  }

  fetchTimeline(request: HistoryReplayRequest): HistoryView {
    const record = this.runs.find((item) => item.runId === request.runId);
    if (!record) {
      throw new Error(`E_RUN_NOT_FOUND: unable to locate run ${request.runId}`);
    }
    if (request.mode === 'live') {
      const snapshot = this.runStateGateway.fetchSnapshot();
      if (!snapshot) {
        throw new Error(
          `E_STATE_UNAVAILABLE: no live snapshot available for run ${request.runId}`,
        );
      }
      return {
        replayMode: 'live',
        timeline: snapshot.stages.map((stage) => ({
          timestamp: snapshot.generatedAt,
          stageId: stage.id,
          status: stage.status,
        })),
      };
    }
    return this.runStateGateway.buildReplayView(record);
  }

  persistDefaults(userId: string, submission: ConfigSubmission): void {
    this.defaults.set(userId, submission);
  }

  getDefaults(userId: string): RunDefaults | undefined {
    const lastSubmission = this.defaults.get(userId);
    if (!lastSubmission) return undefined;
    return {
      operatorId: userId,
      lastSubmission,
    };
  }

  recordCodexAudit(prompt: CodexPrompt, suggestion: CodexSuggestion): string {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(16).slice(2);
    this.codexAudit.push({
      id,
      prompt,
      suggestion,
      timestamp: new Date().toISOString(),
    });
    this.telemetry.track('codex', 'codex.audit', {
      auditId: id,
      intent: prompt.intent,
    });
    return id;
  }

  listCodexAudit(): Array<{
    id: string;
    prompt: CodexPrompt;
    suggestion: CodexSuggestion;
    timestamp: string;
  }> {
    return [...this.codexAudit];
  }

  subscribe(listener: () => void): () => void {
    return this.historyEmitter.subscribe(listener);
  }

  findArtifact(runId: string, artifactId: string): ArtifactSummary | undefined {
    const run = this.runs.find((record) => record.runId === runId);
    return run?.artifacts.find((artifact) => artifact.artifactId === artifactId);
  }
}
