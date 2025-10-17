import { test, expect } from '@playwright/test';

test.describe('Workflow console acceptance (T-UI-01..T-UI-04)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tm-shell')).toBeVisible();
  });

  test('T-UI-01 renders workflow lanes with artifact inspection', async ({ page }) => {
    await expect(page.locator('.tm-workflow[data-run="run-live-demo"]')).toBeVisible();
    await page.getByRole('button', { name: 'Brief Outline' }).click();
    const modal = page.locator('.tm-artifact-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('pre')).toContainText('Detailed outline content');
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).toBeHidden();
  });

  test('T-UI-02 validates configuration and streams CLI status', async ({ page }) => {
    await page.fill('label:has-text("Variant count") input', '2');
    await page.selectOption('label:has-text("Brief depth") select', 'deep');
    await page.fill('label:has-text("Reviewer bots") input', 'apollo, hermes');
    await page.click('button:has-text("Validate manifest")');
    await expect(
      page.locator('.tm-config__report li', { hasText: /Validating manifest/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('.tm-config__report li', { hasText: /Run run-/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.tm-config__preview pre')).toContainText('"variantCount": 2');
    await expect(page.locator('.tm-history tbody tr')).toHaveCount(3, { timeout: 10_000 });
    const telemetryEvents = await page.evaluate(() => (window as any).__tmTelemetry?.events ?? []);
    expect(telemetryEvents.some((event: { kind: string }) => event.kind === 'config.submit')).toBeTruthy();
  });

  test('T-UI-03 streams, redacts, and publishes Codex drafts', async ({ page }) => {
    await page.selectOption('label:has-text("Intent") select', 'draft_requirement');
    await page.fill('label:has-text("Prompt") textarea', 'Include secret token details for operator context.');
    await page.click('button:has-text("Request assistance")');
    await expect(page.locator('.tm-codex__suggestions li').first()).toContainText('Drafting response');
    await page.click('button:has-text("Redact draft")');
    await expect(page.locator('.tm-codex__suggestions li').first()).toContainText('[redacted]');
    await page.click('button:has-text("Publish draft")');
    await expect(page.locator('.tm-codex__status')).toContainText('Draft published');
    const telemetryEvents = await page.evaluate(() => (window as any).__tmTelemetry?.events ?? []);
    expect(telemetryEvents.some((event: { kind: string }) => event.kind === 'codex.publish')).toBeTruthy();
  });

  test('T-UI-04 freezes workflow during history replay and resumes live mode', async ({ page }) => {
    const replayButton = page.locator('.tm-history tbody tr').first().getByRole('button', { name: 'Replay' });
    await replayButton.click();
    const banner = page.locator('.tm-history__banner');
    await expect(banner).toContainText('Replay mode active');
    const telemetryEvents = await page.evaluate(() => (window as any).__tmTelemetry?.events ?? []);
    expect(telemetryEvents.some((event: { kind: string }) => event.kind === 'history.replay.start')).toBeTruthy();
    await page.getByRole('button', { name: 'Resume live' }).click();
    await expect(banner).toContainText('Live mode');
  });
});
