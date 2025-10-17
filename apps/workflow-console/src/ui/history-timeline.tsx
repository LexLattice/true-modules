import { useEffect, useState } from 'react';
import type { HistoryList, HistoryView } from '../types/canon';
import { HistoryStore } from '../services/history-store';
import { RunStateGateway } from '../services/run-state-gateway';
import { TelemetryHub } from '../services/telemetry';

interface HistoryTimelineProps {
  history: HistoryStore;
  gateway: RunStateGateway;
  userId: string;
  onModeChange(mode: 'live' | 'replay'): void;
  telemetry: TelemetryHub;
}

export function HistoryTimeline({
  history,
  gateway,
  userId,
  onModeChange,
  telemetry,
}: HistoryTimelineProps) {
  const [historyList, setHistoryList] = useState<HistoryList>({ items: [] });
  const [view, setView] = useState<HistoryView | null>(null);
  const [mode, setMode] = useState<'live' | 'replay'>('live');

  useEffect(() => {
    try {
      setHistoryList(history.loadHistory({ userId, limit: 10 }));
    } catch (error) {
      console.error('Unable to load history', error);
    }
  }, [history, userId]);

  useEffect(() => {
    return history.subscribe(() => {
      setHistoryList(history.loadHistory({ userId, limit: 10 }));
    });
  }, [history, userId]);

  const handleReplay = (runId: string) => {
    try {
      const nextView = history.fetchTimeline({ runId, mode: 'replay' });
      setView(nextView);
      setMode('replay');
      onModeChange('replay');
      telemetry.track('history', 'history.replay.start', { runId });
    } catch (error) {
      console.error('Replay failed', error);
    }
  };

  const handleResume = () => {
    setView(null);
    setMode('live');
    onModeChange('live');
    telemetry.track('history', 'history.replay.stop', {});
    const snapshot = gateway.fetchSnapshot();
    if (snapshot) {
      setView({
        replayMode: 'live',
        timeline: snapshot.stages.map((stage) => ({
          timestamp: snapshot.generatedAt,
          stageId: stage.id,
          status: stage.status,
        })),
      });
    }
  };

  const handleExportEvents = () => {
    const payload = telemetry.exportAsNdjson();
    const blob = new Blob([payload], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'events.ndjson';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="tm-history">
      <header>
        <h2>History timeline</h2>
        <div className="tm-history__controls">
          <button type="button" onClick={handleResume}>
            Resume live
          </button>
          <button type="button" onClick={handleExportEvents}>
            Export events
          </button>
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Completed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {historyList.items.map((item) => (
            <tr key={item.runId}>
              <td>{item.runId}</td>
              <td>{item.status}</td>
              <td>{new Date(item.completedAt).toLocaleString()}</td>
              <td>
                <button type="button" onClick={() => handleReplay(item.runId)}>
                  Replay
                </button>
                <button type="button" onClick={() => downloadRun(item.runId, item.summary)}>
                  Export
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view ? (
        <div className={`tm-history__banner tm-history__banner--${mode}`} role="status">
          {mode === 'replay' ? 'Replay mode active' : 'Live mode'}
        </div>
      ) : null}
      {view ? (
        <ol className="tm-history__timeline">
          {view.timeline.map((entry) => (
            <li key={`${entry.timestamp}-${entry.stageId}`}>
              <strong>{entry.stageId}</strong>: {entry.status} at{' '}
              {new Date(entry.timestamp).toLocaleTimeString()}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function downloadRun(runId: string, summary: string) {
  const blob = new Blob([summary], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${runId}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}
