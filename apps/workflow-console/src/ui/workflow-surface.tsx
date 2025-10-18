import { useEffect, useState } from 'react';
import type {
  ArtifactRef,
  ArtifactView,
  WorkflowSnapshot,
} from '../types/canon';
import { RunStateGateway } from '../services/run-state-gateway';
import { HistoryStore } from '../services/history-store';
import { TelemetryHub } from '../services/telemetry';

interface WorkflowSurfaceProps {
  gateway: RunStateGateway;
  history: HistoryStore;
  snapshot: WorkflowSnapshot | null;
  onReplayChange(mode: 'live' | 'replay'): void;
  telemetry: TelemetryHub;
}

export function WorkflowSurface({
  gateway,
  history,
  snapshot,
  onReplayChange,
  telemetry,
}: WorkflowSurfaceProps) {
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRef | null>(null);
  const [artifactView, setArtifactView] = useState<ArtifactView | null>(null);

  useEffect(() => {
    if (!selectedArtifact) return;
    try {
      const view = inspectArtifact(history, snapshot, selectedArtifact);
      setArtifactView(view);
      telemetry.track('workflow', 'artifact.inspect', {
        artifactId: selectedArtifact.artifactId,
        stageId: selectedArtifact.stageId,
      });
    } catch (error) {
      setArtifactView({
        ref: selectedArtifact,
        content: (error as Error).message,
      });
    }
  }, [selectedArtifact, history, snapshot, telemetry]);

  const stages = snapshot?.stages ?? [];

  return (
    <div className="tm-workflow" data-run={snapshot?.runId ?? 'pending'}>
      <header className="tm-workflow__header">
        <div>
          <h2>Workflow</h2>
          <p className="tm-workflow__meta">Run ID: {snapshot?.runId ?? 'N/A'}</p>
        </div>
        <div className="tm-workflow__actions">
          <button type="button" onClick={() => onReplayChange('live')}>
            Resume Live
          </button>
        </div>
      </header>
      <div className="tm-workflow__lanes">
        {stages.map((stage) => (
          <div key={stage.id} className={`tm-stage tm-stage--${stage.status}`}>
            <header>
              <h3>{stage.name}</h3>
              <span className={`tm-status tm-status--${stage.status}`}>
                {stage.status}
              </span>
            </header>
            <ul className="tm-dependencies">
              {stage.dependencies.map((dep) => (
                <li
                  key={dep.id}
                  className={`tm-dependency tm-dependency--${dep.status}`}
                  title={dep.blockers?.length ? dep.blockers.join(', ') : undefined}
                >
                  <span>{dep.label}</span>
                  {dep.blockers?.length ? (
                    <span className="tm-dependency__tooltip">
                      Blocked by {dep.blockers.join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <ul className="tm-artifacts">
              {stage.artifacts.map((artifact) => (
                <li key={artifact.artifactId}>
                  <button
                    type="button"
                    onClick={() => {
                      onReplayChange('live');
                      setSelectedArtifact({
                        stageId: stage.id,
                        artifactId: artifact.artifactId,
                      });
                    }}
                  >
                    {artifact.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {artifactView ? (
        <div className="tm-artifact-modal" role="dialog" aria-modal="true">
          <header>
            <h3>Artifact {artifactView.ref.artifactId}</h3>
            <button
              type="button"
              onClick={() => {
                setArtifactView(null);
                setSelectedArtifact(null);
              }}
            >
              Close
            </button>
          </header>
          <pre>{artifactView.content}</pre>
        </div>
      ) : null}
    </div>
  );
}

function inspectArtifact(
  history: HistoryStore,
  snapshot: WorkflowSnapshot | null,
  ref: ArtifactRef,
): ArtifactView {
  const snapshotArtifact = snapshot?.stages
    .find((stage) => stage.id === ref.stageId)
    ?.artifacts.find((artifact) => artifact.artifactId === ref.artifactId);

  if (snapshotArtifact) {
    return {
      ref,
      content:
        snapshotArtifact.content
        ?? snapshotArtifact.preview
        ?? snapshotArtifact.label,
    };
  }

  const runId = snapshot?.runId;
  if (runId) {
    const artifact = history.findArtifact(runId, ref.artifactId);
    if (artifact) {
      return {
        ref,
        content: artifact.content ?? artifact.preview ?? artifact.label,
      };
    }
  }
  const fallbackHistory = history.loadHistory({ userId: 'system', limit: 5 }).items;
  for (const record of fallbackHistory) {
    const artifact = record.artifacts.find((item) => item.artifactId === ref.artifactId);
    if (artifact) {
      return {
        ref,
        content: artifact.content ?? artifact.preview ?? artifact.label,
      };
    }
  }
  throw new Error('Artifact not found');
}
