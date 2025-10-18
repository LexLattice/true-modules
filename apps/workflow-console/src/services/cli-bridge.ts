import type {
  KickoffReceipt,
  RunIdentifier,
  RunManifest,
  ValidationReport,
  CLIStatusUpdate,
} from '../types/canon';
import { createEmitter } from './emitter';
import { TelemetryHub } from './telemetry';

/**
 * CLIBridge simulates calls to tm.mjs. In lieu of actually spawning processes,
 * we validate the manifest shape and echo deterministic responses. This keeps
 * the module deterministic for tests while preserving the interface.
 */
export class CLIBridge {
  private statusEmitter = createEmitter<CLIStatusUpdate>();

  constructor(private telemetry: TelemetryHub) {}

  validateManifest(
    manifest: RunManifest,
    context?: { runId: string },
  ): ValidationReport {
    if (context?.runId) {
      this.pushStatus({
        runId: context.runId,
        phase: 'validation',
        level: 'info',
        message: 'Validating manifest…',
        timestamp: new Date().toISOString(),
      });
    }
    if (manifest.parameters.variantCount <= 0) {
      if (context?.runId) {
        this.pushStatus({
          runId: context.runId,
          phase: 'validation',
          level: 'error',
          message: 'Variant count must be greater than zero.',
          timestamp: new Date().toISOString(),
        });
      }
      return {
        status: 'error',
        messages: ['Variant count must be greater than zero.'],
      };
    }
    const report: ValidationReport = {
      status: 'ok',
      messages: ['Validation successful.'],
      manifestHash: this.hashManifest(manifest),
    };
    if (context?.runId) {
      this.pushStatus({
        runId: context.runId,
        phase: 'validation',
        level: 'info',
        message: 'Manifest validated successfully.',
        timestamp: new Date().toISOString(),
      });
    }
    return report;
  }

  kickoffRun(manifest: RunManifest): KickoffReceipt {
    if (!manifest.readyForLaunch) {
      throw new Error(
        `E_CONFLICT: manifest ${manifest.runId} is not ready for launch (readyForLaunch=false)`,
      );
    }
    const receipt: KickoffReceipt = {
      runId: manifest.runId,
      acceptedAt: new Date().toISOString(),
    };
    this.pushStatus({
      runId: manifest.runId,
      phase: 'kickoff',
      level: 'info',
      message: 'Run kickoff accepted by CLI.',
      timestamp: receipt.acceptedAt,
    });
    return receipt;
  }

  status(identifier: RunIdentifier): ValidationReport {
    if (!identifier.runId) {
      throw new Error('E_CLI_FAILURE');
    }
    const report: ValidationReport = {
      status: 'ok',
      messages: [`Run ${identifier.runId} is healthy.`],
    };
    this.pushStatus({
      runId: identifier.runId,
      phase: 'status',
      level: 'info',
      message: `Run ${identifier.runId} is healthy.`,
      timestamp: new Date().toISOString(),
    });
    return report;
  }

  private hashManifest(manifest: RunManifest): string {
    const json = JSON.stringify(manifest);
    let hash = 0;
    for (let i = 0; i < json.length; i += 1) {
      hash = (hash * 31 + json.charCodeAt(i)) % 1_000_000_007;
    }
    return hash.toString(16);
  }

  subscribeStatus(listener: (update: CLIStatusUpdate) => void): () => void {
    return this.statusEmitter.subscribe(listener);
  }

  private pushStatus(update: CLIStatusUpdate): void {
    this.statusEmitter.emit(update);
    this.telemetry.track('configuration', 'cli.status', update);
  }
}
