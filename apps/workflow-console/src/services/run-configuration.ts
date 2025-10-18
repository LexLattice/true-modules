import type {
  ConfigFormState,
  ConfigSubmission,
  ConfigSubmissionResult,
  ConfigTemplate,
  RunManifest,
  ValidationReport,
} from '../types/canon';
import { HistoryStore } from './history-store';
import { CLIBridge } from './cli-bridge';
import { TelemetryHub } from './telemetry';

export class RunConfigurationService {
  constructor(
    private cli: CLIBridge,
    private history: HistoryStore,
    private telemetry: TelemetryHub,
  ) {}

  loadTemplate(template: ConfigTemplate, userId: string): ConfigFormState {
    const defaults = this.history.getDefaults(userId)?.lastSubmission;
    const values: Record<string, unknown> = {};
    template.fields.forEach((field) => {
      const fallback = defaults?.[field.id as keyof ConfigSubmission];
      values[field.id] = fallback ?? field.default;
    });
    return {
      templateVersion: template.version,
      fields: template.fields,
      values,
    };
  }

  prepareManifest(submission: ConfigSubmission, runId: string): RunManifest {
    const manifest: RunManifest = {
      runId,
      parameters: {
        variantCount: submission.variantCount,
        briefDepth: submission.briefDepth,
        reviewerBots: submission.reviewerBots,
        followUpPolicy: submission.followUpPolicy,
      },
      readyForLaunch: submission.variantCount > 0,
      createdAt: new Date().toISOString(),
    };
    return manifest;
  }

  validateManifest(manifest: RunManifest): ValidationReport {
    return this.cli.validateManifest(manifest, { runId: manifest.runId });
  }

  persistDefaults(userId: string, submission: ConfigSubmission): void {
    this.history.persistDefaults(userId, submission);
  }

  submit(
    submission: ConfigSubmission,
    runId: string,
    operatorId: string,
  ): ConfigSubmissionResult & { manifest: RunManifest; report: ValidationReport } {
    const manifest = this.prepareManifest(submission, runId);
    const report = this.validateManifest(manifest);
    const result: ConfigSubmissionResult = {
      valid: report.status === 'ok',
      manifestRef: report.status === 'ok' ? manifest.runId : undefined,
      errors: report.status === 'ok' ? undefined : report.messages,
    };
    if (result.valid) {
      this.persistDefaults(operatorId, submission);
      this.cli.kickoffRun(manifest);
      this.cli.status({ runId: manifest.runId });
      this.history.appendRun({
        runId: manifest.runId,
        manifest,
        completedAt: new Date().toISOString(),
        status: 'success',
        summary: `Run ${manifest.runId} queued by ${operatorId}.`,
        artifacts: [
          {
            artifactId: `${manifest.runId}-brief`,
            label: 'Brief Outline',
            type: 'brief',
            preview: `Variant count: ${manifest.parameters.variantCount}`,
            content: JSON.stringify(manifest, null, 2),
          },
        ],
      });
    }
    this.telemetry.track('configuration', 'config.submit', {
      operatorId,
      runId: manifest.runId,
      valid: result.valid,
    });
    return { ...result, manifest, report };
  }
}
