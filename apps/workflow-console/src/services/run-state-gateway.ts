import type {
  HistoryView,
  RunHistoryRecord,
  WorkflowSnapshot,
} from '../types/canon';
import { createEmitter } from './emitter';

export type RunStateListener = (snapshot: WorkflowSnapshot) => void;

/**
 * RunStateGateway maintains an in-memory snapshot for the active run and
 * notifies subscribers whenever the snapshot updates. The gateway also allows
 * the history timeline to request snapshots for replay mode.
 */
export class RunStateGateway {
  private emitter = createEmitter<WorkflowSnapshot>();
  private latestSnapshot: WorkflowSnapshot | null = null;
  private simulationTimer: ReturnType<typeof setInterval> | null = null;

  subscribeUpdates(listener: RunStateListener): () => void {
    const unsubscribe = this.emitter.subscribe(listener);
    if (this.latestSnapshot) {
      listener(this.latestSnapshot);
    }
    return unsubscribe;
  }

  publishSnapshot(snapshot: WorkflowSnapshot): void {
    this.latestSnapshot = snapshot;
    this.emitter.emit(snapshot);
  }

  fetchSnapshot(): WorkflowSnapshot | null {
    return this.latestSnapshot;
  }

  buildReplayView(record: RunHistoryRecord): HistoryView {
    return {
      replayMode: 'replay',
      timeline: record.artifacts.map((artifact, index) => ({
        timestamp: new Date(
          new Date(record.completedAt).getTime() - index * 120000,
        ).toISOString(),
        stageId: artifact.type,
        status: 'complete',
        note: artifact.preview ?? artifact.content,
      })),
    };
  }

  simulateProgression(
    snapshots: WorkflowSnapshot[],
    intervalMs = 2500,
  ): () => void {
    if (!snapshots.length) {
      return () => undefined;
    }
    let index = 0;
    this.publishSnapshot(snapshots[0]);
    this.clearSimulation();
    this.simulationTimer = setInterval(() => {
      index += 1;
      if (index >= snapshots.length) {
        this.clearSimulation();
        return;
      }
      this.publishSnapshot(snapshots[index]);
    }, intervalMs);
    return () => this.clearSimulation();
  }

  private clearSimulation(): void {
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
  }
}
