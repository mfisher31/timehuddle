import { expect, test } from '@playwright/test';

const TEST_EMAIL = 'alice@example.com';
const TEST_PASSWORD = 'Password1!';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/app');
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard', { timeout: 15000 });
}

async function ensureClockedOut(page: import('@playwright/test').Page) {
  // page.request shares the browser's cookie jar. The backend is at port 4000;
  // localhost cookies are shared across ports so the auth session is included.
  const activeRes = await page.request.get('http://localhost:4000/v1/clock/active');
  const { event } = (await activeRes.json()) as { event: { id: string } | null };
  if (!event) return;

  await page.request.post('http://localhost:4000/v1/clock/stop');
}

async function ensureNoRunningTimer(page: import('@playwright/test').Page) {
  await page.goto('/app/work');
  const stopButton = page.getByRole('button', { name: 'Stop timer' }).first();
  const hasRunningTimer = await stopButton.isVisible().catch(() => false);
  if (!hasRunningTimer) return;

  await stopButton.click();
  await expect(page.getByRole('button', { name: 'Start timer' }).first()).toBeVisible({
    timeout: 10000,
  });
}

async function createTicket(page: import('@playwright/test').Page, title: string) {
  await page.goto('/app/tickets');
  await page.waitForSelector('button:has-text("New Ticket")', { timeout: 15000 });
  await page.getByRole('button', { name: 'New Ticket' }).click();
  await page.getByPlaceholder('Ticket title').fill(title);
  await page.getByRole('button', { name: 'Create Ticket' }).click();
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10000 });
}

async function openTicketMenu(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('li').filter({ hasText: title }).first();
  await row.getByRole('button', { name: 'Ticket options' }).click();
}

async function deleteTicket(page: import('@playwright/test').Page, title: string) {
  await page.goto('/app/tickets');
  await page.waitForSelector('button:has-text("New Ticket")', { timeout: 15000 });
  await openTicketMenu(page, title);
  await page.getByRole('menuitem', { name: 'Delete Ticket' }).click();
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(title)).not.toBeVisible({ timeout: 10000 });
}

async function createWorkItem(page: import('@playwright/test').Page, note: string) {
  await page.getByRole('button', { name: 'Add work item' }).click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('combobox', { name: 'Ticket' }).click();
  await page.getByRole('option').first().click();

  await dialog.getByLabel('Note (optional)').fill(note);
  await dialog.getByRole('button', { name: 'Add work item' }).click();

  await expect(page.getByText(note).first()).toBeVisible({ timeout: 10000 });
}

test.describe('Work Page', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    await ensureClockedOut(page);
    await ensureNoRunningTimer(page);
  });

  test('creates a work item and shows it in day table', async ({ page }) => {
    const ticketTitle = `Work E2E Ticket ${Date.now()}`;
    const note = `work-note-${Date.now()}`;

    await createTicket(page, ticketTitle);
    await page.goto('/app/work');
    await createWorkItem(page, note);

    await deleteTicket(page, ticketTitle);
  });

  test('start timer prompts clock-in, then allows stop', async ({ page }) => {
    const ticketTitle = `Work Timer Ticket ${Date.now()}`;
    const note = `timer-note-${Date.now()}`;

    await createTicket(page, ticketTitle);
    await page.goto('/app/work');
    await page.getByRole('button', { name: 'Today' }).click();
    await createWorkItem(page, note);

    const row = page.locator('tr').filter({ hasText: note }).first();
    const startButton = row.getByRole('button', { name: 'Start timer' });

    if (await startButton.isDisabled()) {
      const anyStopButton = page.getByRole('button', { name: 'Stop timer' }).first();
      const hasVisibleRunningTimer = await anyStopButton.isVisible().catch(() => false);
      if (hasVisibleRunningTimer) {
        await anyStopButton.click();
      }
      await page.getByRole('button', { name: 'Today' }).click();
    }

    await expect(startButton).toBeEnabled({ timeout: 10000 });
    await startButton.click();

    const prompt = page.locator('[role="dialog"]').filter({ hasText: 'Clock In Required' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Clock In Now' }).click();

    await expect(row.getByText('Running')).toBeVisible({ timeout: 10000 });
    await row.getByRole('button', { name: 'Stop timer' }).click();
    await expect(row.getByText('Running')).not.toBeVisible({ timeout: 10000 });

    await deleteTicket(page, ticketTitle);
  });

  test('edits and deletes a work item from the edit dialog', async ({ page }) => {
    const ticketTitle = `Work Edit Ticket ${Date.now()}`;
    const initialNote = `edit-note-${Date.now()}`;
    const updatedNote = `${initialNote}-updated`;

    await createTicket(page, ticketTitle);
    await page.goto('/app/work');
    await createWorkItem(page, initialNote);

    const row = page.locator('tr').filter({ hasText: initialNote }).first();
    await row.getByRole('button', { name: 'Edit work item' }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Note (optional)').fill(updatedNote);
    await dialog.getByRole('button', { name: 'Update' }).click();

    await expect(page.getByText(updatedNote).first()).toBeVisible({ timeout: 10000 });

    const updatedRow = page.locator('tr').filter({ hasText: updatedNote }).first();
    await updatedRow.getByRole('button', { name: 'Edit work item' }).click();
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText(updatedNote)).not.toBeVisible({ timeout: 10000 });

    await deleteTicket(page, ticketTitle);
  });
});
