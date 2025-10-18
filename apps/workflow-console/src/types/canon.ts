/**
 * Canon-derived TypeScript types used by the workflow console.
 * These interfaces mirror a subset of the JSON schema in `amr/schemas.json`.
 * They intentionally focus on the structures consumed by the UI and services.
 */

export type Role = 'operator' | 'observer' | 'admin';

export interface User {
  id: string;
  role: Role;
  team?: string;
}

export interface ShellLoadRequest {
  user: User;
  runId?: string;
  focusPanel?: 'workflow' | 'config' | 'codex';
}

export interface NavItem {
  id: string;
  label: string;
}

export interface ShellLoadResponse {
  activePanels: number;
  nav: { items: NavItem[] };
  runDefaults?: RunDefaults;
}

export type UISource = 'workflow' | 'configuration' | 'codex' | 'history';

export interface UIEvent {
  id: string;
  source: UISource;
  kind: string;
  schema: 'tm-events@1';
  payload: unknown;
  timestamp: string;
}

export interface UIRouteAck {
  accepted: boolean;
  forwarded_to?: string;
  reason?: string;
}

export interface StageDependency {
  id: string;
  label: string;
  status: 'ready' | 'blocked' | 'warning';
  blockers?: string[];
}

export interface WorkflowStage {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'complete' | 'error';
  startedAt?: string;
  completedAt?: string;
  dependencies: StageDependency[];
  artifacts: ArtifactSummary[];
}

export interface WorkflowSnapshot {
  runId: string;
  stages: WorkflowStage[];
  generatedAt: string;
}

export interface RenderResult {
  sections: number;
  lastUpdated: string;
}

export interface ArtifactSummary {
  artifactId: string;
  label: string;
  type: string;
  preview?: string;
  content?: string;
}

export interface ArtifactRef {
  stageId: string;
  artifactId: string;
}

export interface ArtifactView {
  ref: ArtifactRef;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConfigTemplateField {
  id: string;
  label: string;
  description?: string;
  default: string | number | boolean | string[];
  required?: boolean;
  enum?: string[];
}

export interface ConfigTemplate {
  version: string;
  fields: ConfigTemplateField[];
}

export interface ConfigFormState {
  templateVersion: string;
  fields: ConfigTemplateField[];
  values: Record<string, unknown>;
  manifestPreview?: RunManifest;
  errors?: string[];
}

export interface ConfigSubmission {
  variantCount: number;
  briefDepth: 'shallow' | 'standard' | 'deep';
  reviewerBots: string[];
  followUpPolicy: 'auto' | 'manual' | 'hybrid';
  annotations?: Record<string, string>;
}

export interface ConfigSubmissionResult {
  valid: boolean;
  manifestRef?: string;
  errors?: string[];
}

export interface RunManifest {
  runId: string;
  parameters: {
    variantCount: number;
    briefDepth: ConfigSubmission['briefDepth'];
    reviewerBots: string[];
    followUpPolicy: ConfigSubmission['followUpPolicy'];
  };
  readyForLaunch: boolean;
  createdAt: string;
}

export interface ValidationReport {
  status: 'ok' | 'error';
  messages: string[];
  manifestHash?: string;
}

export interface RunDefaults {
  operatorId: string;
  lastSubmission?: ConfigSubmission;
}

export interface CodexPrompt {
  intent: 'draft_brief' | 'draft_requirement' | 'draft_note';
  input: string;
  sessionId: string;
}

export interface CodexSuggestion {
  id: string;
  content: string;
  redacted?: boolean;
  tokens: number;
}

export interface CodexSuggestionStream {
  suggestions: CodexSuggestion[];
  finalized: boolean;
}

export type CodexStreamListener = (stream: CodexSuggestionStream) => void;

export interface CodexStreamHandle {
  stream: CodexSuggestionStream;
  subscribe(listener: CodexStreamListener): () => void;
  redact(): CodexSuggestionStream;
  publishDraft(): CodexPublishReceipt;
}

export interface CodexPublishReceipt {
  auditId: string;
  saved: boolean;
}

export interface RunHistoryRecord {
  runId: string;
  manifest: RunManifest;
  completedAt: string;
  status: 'success' | 'failed';
  summary: string;
  artifacts: ArtifactSummary[];
}

export interface HistoryReceipt {
  saved: boolean;
  runId: string;
}

export interface HistoryQuery {
  userId: string;
  limit?: number;
}

export interface HistoryList {
  items: RunHistoryRecord[];
}

export interface HistoryReplayRequest {
  runId: string;
  mode: 'live' | 'replay';
}

export interface HistoryView {
  replayMode: 'live' | 'replay';
  timeline: Array<{
    timestamp: string;
    stageId: string;
    status: WorkflowStage['status'];
    note?: string;
  }>;
}

export interface RunIdentifier {
  runId: string;
}

export interface KickoffReceipt {
  runId: string;
  acceptedAt: string;
}

export interface CLIStatusUpdate {
  runId: string;
  phase: 'validation' | 'kickoff' | 'status';
  level: 'info' | 'error';
  message: string;
  timestamp: string;
}
