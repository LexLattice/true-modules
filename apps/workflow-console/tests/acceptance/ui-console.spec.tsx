import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { act } from 'react-dom/test-utils';
import ReactDOM from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Shell } from '../../src/ui/shell';
import { bootstrapConsole, demoShellRequest } from '../../src/bootstrap';

let container: HTMLElement;
let root: Root | null = null;

function renderConsole() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = ReactDOM.createRoot(container);
    root.render(<Shell request={demoShellRequest} bootstrap={bootstrapConsole} />);
  });
}

function cleanupConsole() {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  if (container && container.parentElement) {
    container.parentElement.removeChild(container);
  }
}

function telemetryEvents(): Array<{ kind: string }> {
  return (window as any).__tmTelemetry?.events ?? [];
}

async function waitFor(condition: () => boolean, timeout = 2000, interval = 20) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor timeout');
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Button with label "${label}" not found`);
  }
  return button as HTMLButtonElement;
}

function inputByLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(labelText),
  );
  if (!label) {
    throw new Error(`Label with text "${labelText}" not found`);
  }
  const input = label.querySelector('input');
  if (!input) {
    throw new Error(`Input for label "${labelText}" not found`);
  }
  return input as HTMLInputElement;
}

function textareaByLabel(labelText: string): HTMLTextAreaElement {
  const label = Array.from(container.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(labelText),
  );
  if (!label) {
    throw new Error(`Label with text "${labelText}" not found`);
  }
  const textarea = label.querySelector('textarea');
  if (!textarea) {
    throw new Error(`Textarea for label "${labelText}" not found`);
  }
  return textarea as HTMLTextAreaElement;
}

function selectByLabel(labelText: string): HTMLSelectElement {
  const label = Array.from(container.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(labelText),
  );
  if (!label) {
    throw new Error(`Label with text "${labelText}" not found`);
  }
  const select = label.querySelector('select');
  if (!select) {
    throw new Error(`Select for label "${labelText}" not found`);
  }
  return select as HTMLSelectElement;
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function clickButton(button: HTMLButtonElement) {
  act(() => {
    button.click();
  });
}

describe('Workflow console acceptance (T-UI-01..T-UI-04)', () => {
  beforeEach(async () => {
    renderConsole();
    await waitFor(() => Boolean(container.querySelector('.tm-workflow')));
  });

  afterEach(() => {
    cleanupConsole();
  });

  it('T-UI-01 renders workflow lanes with artifact inspection', async () => {
    expect(container.querySelector('.tm-workflow')).not.toBeNull();

    clickButton(findButton('Brief Outline'));
    await waitFor(() => Boolean(container.querySelector('.tm-artifact-modal')));
    const modal = container.querySelector('.tm-artifact-modal');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('pre')?.textContent ?? '').toContain('Detailed outline content');
    clickButton(modal?.querySelector('button') as HTMLButtonElement);
    await waitFor(() => !container.querySelector('.tm-artifact-modal'));
  });

  it('T-UI-02 validates configuration and streams CLI status', async () => {
    const variantField = inputByLabel('Variant count');
    setInputValue(variantField, '2');

    const depthSelect = selectByLabel('Brief depth');
    setSelectValue(depthSelect, 'deep');

    const reviewerField = inputByLabel('Reviewer bots');
    setInputValue(reviewerField, 'apollo, hermes');

    clickButton(findButton('Validate manifest'));

    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-config__report')
          ?.textContent?.includes('Validating manifest'),
      ),
    );
    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-config__report')
          ?.textContent?.includes('Run run-'),
      ),
    );
    await waitFor(() =>
      Boolean(
        container.querySelector('.tm-config__preview pre')?.textContent?.includes('"variantCount": 2'),
      ),
    );

    await waitFor(() => container.querySelectorAll('.tm-history tbody tr').length === 3);

    await waitFor(() =>
      telemetryEvents().some((event) => event.kind === 'config.submit'),
    );
  });

  it('T-UI-03 streams, redacts, and publishes Codex drafts', async () => {
    const intentSelect = selectByLabel('Intent');
    setSelectValue(intentSelect, 'draft_requirement');

    const promptField = textareaByLabel('Prompt');
    setInputValue(promptField, 'Include secret token details for operator context.');

    clickButton(findButton('Request assistance'));

    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-codex__suggestions')
          ?.textContent?.includes('Drafting response'),
      ),
    );

    clickButton(findButton('Redact draft'));
    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-codex__suggestions')
          ?.textContent?.includes('[redacted]'),
      ),
    );

    clickButton(findButton('Publish draft'));
    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-codex__status')
          ?.textContent?.includes('Draft published'),
      ),
    );

    await waitFor(() =>
      telemetryEvents().some((event) => event.kind === 'codex.publish'),
    );
  });

  it('T-UI-04 freezes workflow during history replay and resumes live mode', async () => {
    const replayButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((button) => button.textContent?.trim() === 'Replay');
    expect(replayButtons.length).toBeGreaterThan(0);
    clickButton(replayButtons[0]);

    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-history__banner')
          ?.textContent?.includes('Replay mode active'),
      ),
    );

    await waitFor(() =>
      telemetryEvents().some((event) => event.kind === 'history.replay.start'),
    );

    clickButton(findButton('Resume live'));
    await waitFor(() =>
      Boolean(
        container
          .querySelector('.tm-history__banner')
          ?.textContent?.includes('Live mode'),
      ),
    );
  });
});
