import type {
  ConfigSubmission,
  ShellLoadRequest,
  WorkflowSnapshot,
} from './types/canon';
import type { ConsoleServices } from './services/console-services';

export const demoShellRequest: ShellLoadRequest = {
  user: {
    id: 'operator-42',
    role: 'operator',
    team: 'amr-ops',
  },
  focusPanel: 'workflow',
};

export function bootstrapConsole(services: ConsoleServices) {
  const submission: ConfigSubmission = {
    variantCount: 3,
    briefDepth: 'standard',
    reviewerBots: ['reviewer-alpha', 'reviewer-beta'],
    followUpPolicy: 'manual',
  };
  services.history.persistDefaults(demoShellRequest.user.id, submission);

  const baseSnapshot: WorkflowSnapshot = {
    runId: 'run-live-demo',
    generatedAt: new Date().toISOString(),
    stages: [
      {
        id: 'briefing',
        name: 'Brief Composition',
        status: 'running',
        startedAt: new Date().toISOString(),
        dependencies: [],
        artifacts: [
          {
            artifactId: 'briefing-outline',
            label: 'Brief Outline',
            type: 'brief',
            preview: 'Outline ready for review',
            content: 'Detailed outline content with context and prompts.',
          },
        ],
      },
      {
        id: 'analysis',
        name: 'Analysis',
        status: 'idle',
        dependencies: [
          {
            id: 'briefing',
            label: 'Brief ready',
            status: 'blocked',
            blockers: ['Await brief approval'],
          },
        ],
        artifacts: [],
      },
      {
        id: 'synthesis',
        name: 'Synthesis',
        status: 'idle',
        dependencies: [
          {
            id: 'analysis',
            label: 'Analysis complete',
            status: 'blocked',
            blockers: ['Analysis pending'],
          },
        ],
        artifacts: [],
      },
    ],
  };

  const progression: WorkflowSnapshot[] = [
    baseSnapshot,
    {
      ...baseSnapshot,
      generatedAt: new Date(Date.now() + 2000).toISOString(),
      stages: [
        {
          ...baseSnapshot.stages[0],
          status: 'complete',
          completedAt: new Date().toISOString(),
        },
        {
          ...baseSnapshot.stages[1],
          status: 'running',
          dependencies: [
            { id: 'briefing', label: 'Brief ready', status: 'ready' },
          ],
          artifacts: [
            {
              artifactId: 'analysis-report',
              label: 'Analysis Report',
              type: 'report',
              preview: 'Risk analysis captured',
              content: 'Full analysis report with insights and reviewer notes.',
            },
          ],
        },
        baseSnapshot.stages[2],
      ],
    },
    {
      ...baseSnapshot,
      generatedAt: new Date(Date.now() + 4000).toISOString(),
      stages: [
        {
          ...baseSnapshot.stages[0],
          status: 'complete',
          completedAt: new Date().toISOString(),
        },
        {
          ...baseSnapshot.stages[1],
          status: 'complete',
          completedAt: new Date().toISOString(),
          artifacts: [
            {
              artifactId: 'analysis-report',
              label: 'Analysis Report',
              type: 'report',
              preview: 'Risk analysis captured',
              content: 'Full analysis report with insights and reviewer notes.',
            },
          ],
          dependencies: [
            { id: 'briefing', label: 'Brief ready', status: 'ready' },
          ],
        },
        {
          ...baseSnapshot.stages[2],
          status: 'running',
          dependencies: [
            { id: 'analysis', label: 'Analysis complete', status: 'ready' },
          ],
          artifacts: [
            {
              artifactId: 'synthesis-pack',
              label: 'Synthesis Pack',
              type: 'package',
              preview: 'Draft package assembled',
              content: 'Synthesis draft package for operator sign-off.',
            },
          ],
        },
      ],
    },
  ];

  services.runState.simulateProgression(progression, 3000);

  const manifest = services.config.prepareManifest(submission, 'run-history-001');
  services.history.appendRun({
    runId: manifest.runId,
    manifest,
    completedAt: new Date(Date.now() - 86_400_000).toISOString(),
    status: 'success',
    summary: 'Baseline workflow execution completed successfully.',
    artifacts: [
      {
        artifactId: 'run-history-001-brief',
        label: 'Brief Outline',
        type: 'brief',
        preview: 'Baseline brief',
        content: 'Baseline brief artifact content',
      },
      {
        artifactId: 'run-history-001-report',
        label: 'Post Mortem',
        type: 'report',
        preview: 'Post mortem summary',
        content: 'Detailed post mortem with reviewer notes.',
      },
    ],
  });

  const manifestTwo = services.config.prepareManifest(
    { ...submission, variantCount: 2 },
    'run-history-002',
  );
  services.history.appendRun({
    runId: manifestTwo.runId,
    manifest: manifestTwo,
    completedAt: new Date(Date.now() - 43_200_000).toISOString(),
    status: 'success',
    summary: 'Replay ready package stored for export.',
    artifacts: [
      {
        artifactId: 'run-history-002-brief',
        label: 'Brief Outline',
        type: 'brief',
        preview: 'Alternate brief snapshot',
        content: 'Alternate brief variant for scenario testing.',
      },
      {
        artifactId: 'run-history-002-report',
        label: 'Telemetry Report',
        type: 'report',
        preview: 'Telemetry summary',
        content: 'Telemetry export for audit pipeline.',
      },
    ],
  });

  services.telemetry.track('workflow', 'console.boot', {
    seededRuns: 2,
    activeRun: progression[0].runId,
  });
}
