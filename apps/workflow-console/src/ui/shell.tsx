import { useEffect, useMemo, useState } from 'react';
import type {
  ShellLoadRequest,
  ShellLoadResponse,
  WorkflowSnapshot,
} from '../types/canon';
import type { ConsoleServices } from '../services/console-services';
import { createConsoleServices } from '../services/console-services';
import { WorkflowSurface } from './workflow-surface';
import { RunConfigurator } from './run-configurator';
import { CodexComposer } from './codex-composer';
import { HistoryTimeline } from './history-timeline';

export interface ShellProps {
  request: ShellLoadRequest;
  bootstrap?: (services: ConsoleServices) => void;
}

export function Shell({ request, bootstrap }: ShellProps) {
  const [response, setResponse] = useState<ShellLoadResponse | null>(null);
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [replayMode, setReplayMode] = useState<'live' | 'replay'>('live');
  const [servicesInitialized, setServicesInitialized] = useState(false);

  const services = useMemo(() => {
    return createConsoleServices();
  }, []);

  useEffect(() => {
    if (servicesInitialized) return;
    services.telemetry.exposeToWindow();
    if (bootstrap) {
      bootstrap(services);
    }
    setSnapshot(services.runState.fetchSnapshot());
    setServicesInitialized(true);
  }, [bootstrap, services, servicesInitialized]);

  useEffect(() => {
    const shellResponse = services.session.loadShell(request);
    setResponse(shellResponse);
    const unsubscribe = services.runState.subscribeUpdates((state) => {
      if (replayMode === 'live') {
        setSnapshot(state);
      }
    });
    const interval = setInterval(() => {
      const current = services.runState.fetchSnapshot();
      if (current && replayMode === 'live') {
        setSnapshot(current);
      }
    }, 1500);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [request, services, replayMode]);

  if (!response) {
    return <div>Loading console…</div>;
  }

  const banner =
    replayMode === 'replay' ? (
      <div className="tm-shell__banner" role="status">
        Replay mode — live updates paused
      </div>
    ) : null;

  return (
    <div className="tm-shell">
      <header className="tm-shell__header">
        <h1>AMR → Bo4 Workflow Console</h1>
        <nav>
          <ul className="tm-shell__nav">
            {response.nav.items.map((item) => (
              <li key={item.id}>{item.label}</li>
            ))}
          </ul>
        </nav>
      </header>
      {banner}
      <main className="tm-shell__body">
        <section className="tm-panel tm-panel--workflow">
          <WorkflowSurface
            gateway={services.runState}
            history={services.history}
            snapshot={snapshot}
            onReplayChange={setReplayMode}
            telemetry={services.telemetry}
          />
        </section>
        <section className="tm-panel tm-panel--config">
          <RunConfigurator
            configurator={services.config}
            user={request.user}
            cli={services.cli}
            telemetry={services.telemetry}
          />
        </section>
        <section className="tm-panel tm-panel--codex">
          <CodexComposer adapter={services.codex} telemetry={services.telemetry} />
        </section>
        <section className="tm-panel tm-panel--history">
          <HistoryTimeline
            history={services.history}
            gateway={services.runState}
            userId={request.user.id}
            onModeChange={setReplayMode}
            telemetry={services.telemetry}
          />
        </section>
      </main>
    </div>
  );
}
