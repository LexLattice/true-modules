import type {
  HistoryList,
  ShellLoadRequest,
  ShellLoadResponse,
  UIEvent,
  UIRouteAck,
} from '../types/canon';
import { RunStateGateway } from './run-state-gateway';
import { RunConfigurationService } from './run-configuration';
import { HistoryStore } from './history-store';
import { TelemetryHub } from './telemetry';

export class SessionFacade {
  constructor(
    private runStateGateway: RunStateGateway,
    private configService: RunConfigurationService,
    private historyStore: HistoryStore,
    private telemetry: TelemetryHub,
  ) {}

  getSnapshot(): ReturnType<RunStateGateway['fetchSnapshot']> {
    return this.runStateGateway.fetchSnapshot();
  }

  loadShell(request: ShellLoadRequest): ShellLoadResponse {
    if (!['operator', 'observer', 'admin'].includes(request.user.role)) {
      throw new Error('E_UNAUTH');
    }
    const navItems = [
      { id: 'workflow', label: 'Workflow' },
      { id: 'config', label: 'Configuration' },
      { id: 'codex', label: 'Codex Composer' },
      { id: 'history', label: 'History' },
    ];
    const defaults = this.historyStore.getDefaults(request.user.id);
    return {
      activePanels: request.focusPanel ? 2 : 3,
      nav: { items: navItems },
      runDefaults: defaults,
    };
  }

  routeEvent(event: UIEvent): UIRouteAck {
    if (!['workflow', 'configuration', 'codex', 'history'].includes(event.source)) {
      return { accepted: false, reason: 'E_EVENT_REJECTED' };
    }
    const ack: UIRouteAck = { accepted: true, forwarded_to: event.source };
    this.telemetry.emit(event);
    return ack;
  }

  loadHistoryForUser(userId: string): HistoryList {
    return this.historyStore.loadHistory({ userId });
  }
}
