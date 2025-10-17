import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConfigTemplate,
  ConfigSubmission,
  RunManifest,
  User,
  ValidationReport,
  CLIStatusUpdate,
} from '../types/canon';
import { RunConfigurationService } from '../services/run-configuration';
import { CLIBridge } from '../services/cli-bridge';
import { TelemetryHub } from '../services/telemetry';

interface RunConfiguratorProps {
  configurator: RunConfigurationService;
  user: User;
  cli: CLIBridge;
  telemetry: TelemetryHub;
}

const DEFAULT_TEMPLATE: ConfigTemplate = {
  version: 'v1',
  fields: [
    {
      id: 'variantCount',
      label: 'Variant count',
      description: 'Number of workflow variants to generate',
      default: 1,
      required: true,
    },
    {
      id: 'briefDepth',
      label: 'Brief depth',
      default: 'standard',
      enum: ['shallow', 'standard', 'deep'],
      required: true,
    },
    {
      id: 'reviewerBots',
      label: 'Reviewer bots',
      default: [],
    },
    {
      id: 'followUpPolicy',
      label: 'Follow-up policy',
      default: 'manual',
      enum: ['auto', 'manual', 'hybrid'],
    },
  ],
};

export function RunConfigurator({
  configurator,
  user,
  cli,
  telemetry,
}: RunConfiguratorProps) {
  const initialState = useMemo(
    () => configurator.loadTemplate(DEFAULT_TEMPLATE, user.id),
    [configurator, user.id],
  );
  const [values, setValues] = useState<Record<string, unknown>>(initialState.values);
  const [manifestPreview, setManifestPreview] = useState<RunManifest | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [statusFeed, setStatusFeed] = useState<CLIStatusUpdate[]>([]);
  const latestRunId = useRef<string | null>(null);

  useEffect(() => {
    return cli.subscribeStatus((entry) => {
      if (latestRunId.current && entry.runId === latestRunId.current) {
        setStatusFeed((prev) => [...prev, entry]);
      }
    });
  }, [cli]);

  const updateField = (field: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setErrors([]);
    const submission: ConfigSubmission = {
      variantCount: Number(values.variantCount ?? 0),
      briefDepth: (values.briefDepth ?? 'standard') as ConfigSubmission['briefDepth'],
      reviewerBots: Array.isArray(values.reviewerBots)
        ? (values.reviewerBots as string[])
        : String(values.reviewerBots ?? '')
            .split(',')
            .map((bot) => bot.trim())
            .filter(Boolean),
      followUpPolicy: (values.followUpPolicy ?? 'manual') as ConfigSubmission['followUpPolicy'],
    };
    try {
      const runId = `run-${Date.now()}`;
      latestRunId.current = runId;
      setStatusFeed([]);
      const { manifest, report, errors: validationErrors } = configurator.submit(
        submission,
        runId,
        user.id,
      );
      setManifestPreview(manifest);
      setValidationReport(report);
      setErrors(validationErrors ?? []);
      telemetry.track('configuration', 'manifest.validated', {
        runId,
        valid: report.status === 'ok',
      });
    } catch (error) {
      setErrors([(error as Error).message]);
    }
  };

  return (
    <form className="tm-config" onSubmit={handleSubmit}>
      <header>
        <h2>Run configuration</h2>
        <p className="tm-config__defaults">Last used manifest version: {initialState.templateVersion}</p>
      </header>
      <label>
        Variant count
        <input
          type="number"
          min={1}
          value={values.variantCount as number}
          onChange={(event) => updateField('variantCount', Number(event.target.value))}
        />
      </label>
      <label>
        Brief depth
        <select
          value={values.briefDepth as string}
          onChange={(event) => updateField('briefDepth', event.target.value)}
        >
          <option value="shallow">Shallow</option>
          <option value="standard">Standard</option>
          <option value="deep">Deep</option>
        </select>
      </label>
      <label>
        Reviewer bots (comma separated)
        <input
          type="text"
          value={(values.reviewerBots as string) ?? ''}
          onChange={(event) => updateField('reviewerBots', event.target.value)}
        />
      </label>
      <label>
        Follow-up policy
        <select
          value={values.followUpPolicy as string}
          onChange={(event) => updateField('followUpPolicy', event.target.value)}
        >
          <option value="manual">Manual</option>
          <option value="auto">Auto</option>
          <option value="hybrid">Hybrid</option>
        </select>
      </label>
      <button type="submit">Validate manifest</button>
      {errors.length ? (
        <ul className="tm-config__errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {manifestPreview ? (
        <section className="tm-config__preview">
          <h3>Manifest preview</h3>
          <pre>{JSON.stringify(manifestPreview, null, 2)}</pre>
        </section>
      ) : null}
      {validationReport ? (
        <section className="tm-config__report">
          <h3>CLI status</h3>
          <ul>
            {statusFeed.map((entry) => (
              <li key={`${entry.phase}-${entry.timestamp}`} className={`tm-status tm-status--${entry.level}`}>
                [{entry.phase}] {entry.message}
              </li>
            ))}
            {statusFeed.length === 0
              ? validationReport.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))
              : null}
          </ul>
        </section>
      ) : null}
    </form>
  );
}
