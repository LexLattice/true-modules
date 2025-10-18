import { CLIBridge } from './cli-bridge';
import { CodexAdapter } from './codex-adapter';
import { HistoryStore } from './history-store';
import { RunConfigurationService } from './run-configuration';
import { RunStateGateway } from './run-state-gateway';
import { SessionFacade } from './session-facade';
import { TelemetryHub } from './telemetry';

export interface ConsoleServices {
  telemetry: TelemetryHub;
  runState: RunStateGateway;
  cli: CLIBridge;
  history: HistoryStore;
  config: RunConfigurationService;
  session: SessionFacade;
  codex: CodexAdapter;
}

export function createConsoleServices(): ConsoleServices {
  const telemetry = new TelemetryHub();
  const runState = new RunStateGateway();
  const history = new HistoryStore(runState, telemetry);
  const cli = new CLIBridge(telemetry);
  const config = new RunConfigurationService(cli, history, telemetry);
  const session = new SessionFacade(runState, config, history, telemetry);
  const codex = new CodexAdapter(history, telemetry);
  return { telemetry, runState, cli, history, config, session, codex };
}
