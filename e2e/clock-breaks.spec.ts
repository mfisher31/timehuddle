/**
 * Clock Break Classification E2E
 *
 * Verifies the full FLSA break classification pipeline end-to-end:
 *
 *  Rule: break duration < 20 min  → "rest"  (compensable, NOT deducted from accumulatedTime)
 *        break duration ≥ 20 min  → "meal"  (non-compensable, deducted from accumulatedTime)
 *
 * Tests:
 *  1. Pause/resume live flow — short break auto-classified as "rest"
 *  2. Boundary: exactly 20 min break → "meal", deducted
 *  3. Sub-boundary: 19 min 59 sec break → "rest", NOT deducted
 *  4. Multi-break: 15min rest + 30min meal → correct totals
 *  5. updateTimes accumulation: 2h shift with 10min rest + 25min meal
 *
 * If these tests break, the FLSA break classification and time accounting are broken.
 */
import { expect, test } from '@playwright/test';

// Use bob (not alice) so parallel CI runs don't clash with alice-based tests
// (work, profile, tickets, api-token, pulsevault all use alice in beforeEach)
const TEST_EMAIL = 'bob@example.com';
const TEST_PASSWORD = 'Password1!';
const API_BASE = 'http://localhost:4000/v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function login(page: import('@playwright/test').Page) {
  await page.goto('/app');
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard', { timeout: 15000 });
}

/** Stop any active clock session so each test starts clean. */
async function ensureClockedOut(page: import('@playwright/test').Page) {
  const res = await page.request.get(`${API_BASE}/clock/active`);
  const { event } = (await res.json()) as { event: { id: string } | null };
  if (!event) return;
  await page.request.post(`${API_BASE}/clock/stop`);
}

/** Clock in. Returns the new event id. */
async function clockIn(page: import('@playwright/test').Page): Promise<{ eventId: string }> {
  const startRes = await page.request.post(`${API_BASE}/clock/start`);
  const { event } = (await startRes.json()) as { event: { id: string } };
  return { eventId: event.id };
}

type ClockBreakShape = {
  startTime: number;
  endTime: number | null;
  type?: 'rest' | 'meal';
  classificationSource?: 'auto' | 'manual';
};

type PublicClockEvent = {
  id: string;
  isPaused: boolean;
  accumulatedTime: number;
  deductedBreakSeconds: number;
  totalBreakSeconds: number;
  workSeconds: number;
  breaks: ClockBreakShape[];
};

/** PUT /clock/:id/times and return the updated event. */
async function updateTimes(
  page: import('@playwright/test').Page,
  eventId: string,
  opts: {
    startTime: number;
    endTime: number;
    breaks: { startTime: number; endTime: number }[];
  },
): Promise<PublicClockEvent> {
  const res = await page.request.put(`${API_BASE}/clock/${eventId}/times`, {
    data: opts,
  });
  const { event } = (await res.json()) as { event: PublicClockEvent };
  return event;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Clock Break Classification', () => {
  // All tests share bob's clock session — run serially to avoid parallel conflicts.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    await ensureClockedOut(page);
  });

  test.afterEach(async ({ page }) => {
    await ensureClockedOut(page);
  });

  // ── Test 1: Live pause → resume ───────────────────────────────────────────

  test('live pause/resume auto-classifies short break as rest', async ({ page }) => {
    await clockIn(page);

    // Pause
    const pauseRes = await page.request.post(`${API_BASE}/clock/pause`);
    const { event: paused } = (await pauseRes.json()) as { event: PublicClockEvent };
    expect(paused.isPaused).toBe(true);

    // Brief wait so endTime > startTime on the break record
    await page.waitForTimeout(1100);

    // Resume
    const resumeRes = await page.request.post(`${API_BASE}/clock/resume`);
    const { event: resumed } = (await resumeRes.json()) as { event: PublicClockEvent };

    expect(resumed.isPaused).toBe(false);

    // The only closed break should be classified as "rest" (it was seconds long)
    const closedBreaks = resumed.breaks.filter((b) => b.endTime !== null);
    expect(closedBreaks).toHaveLength(1);
    expect(closedBreaks[0].type).toBe('rest');
    expect(closedBreaks[0].classificationSource).toBe('auto');

    // rest breaks are NOT deducted
    expect(resumed.deductedBreakSeconds).toBe(0);
  });

  // ── Test 2: Boundary — exactly 20 min = meal ─────────────────────────────

  test('exactly 20-min break is classified as meal and deducted', async ({ page }) => {
    const { eventId } = await clockIn(page);

    const now = Date.now();
    const shiftStart = now - 90 * 60 * 1000; // 90 min ago
    const breakStart = shiftStart + 10 * 60 * 1000;
    const breakEnd = breakStart + 20 * 60 * 1000; // exactly 20 min
    const breakDuration = 20 * 60; // 1200s

    const event = await updateTimes(page, eventId, {
      startTime: shiftStart,
      endTime: now,
      breaks: [{ startTime: breakStart, endTime: breakEnd }],
    });

    expect(event.breaks).toHaveLength(1);
    expect(event.breaks[0].type).toBe('meal');

    const shiftSpan = Math.floor((now - shiftStart) / 1000);
    expect(event.accumulatedTime).toBe(shiftSpan - breakDuration);
    expect(event.deductedBreakSeconds).toBe(breakDuration);
    expect(event.totalBreakSeconds).toBe(breakDuration);
    expect(event.workSeconds).toBe(shiftSpan - breakDuration);
  });

  // ── Test 3: Sub-boundary — 19 min 59 sec = rest ──────────────────────────

  test('19-min-59-sec break is classified as rest and not deducted', async ({ page }) => {
    const { eventId } = await clockIn(page);

    const now = Date.now();
    const shiftStart = now - 60 * 60 * 1000; // 60 min ago
    const breakStart = shiftStart + 10 * 60 * 1000;
    const breakEnd = breakStart + 19 * 60 * 1000 + 59 * 1000; // 19 min 59 sec
    const breakDuration = 19 * 60 + 59; // 1199s

    const event = await updateTimes(page, eventId, {
      startTime: shiftStart,
      endTime: now,
      breaks: [{ startTime: breakStart, endTime: breakEnd }],
    });

    expect(event.breaks).toHaveLength(1);
    expect(event.breaks[0].type).toBe('rest');

    const shiftSpan = Math.floor((now - shiftStart) / 1000);
    // rest breaks are NOT deducted — full shift span is accumulated
    expect(event.accumulatedTime).toBe(shiftSpan);
    expect(event.deductedBreakSeconds).toBe(0);
    expect(event.totalBreakSeconds).toBe(breakDuration);
    expect(event.workSeconds).toBe(shiftSpan);
  });

  // ── Test 4: Multi-break — 15min rest + 30min meal ────────────────────────

  test('multi-break: 15min rest and 30min meal produce correct totals', async ({ page }) => {
    const { eventId } = await clockIn(page);

    const now = Date.now();
    const shiftStart = now - 3 * 60 * 60 * 1000; // 3h ago

    const rest15Start = shiftStart + 30 * 60 * 1000;
    const rest15End = rest15Start + 15 * 60 * 1000; // 15 min → rest

    const meal30Start = shiftStart + 90 * 60 * 1000;
    const meal30End = meal30Start + 30 * 60 * 1000; // 30 min → meal

    const restDuration = 15 * 60; // 900s
    const mealDuration = 30 * 60; // 1800s

    const event = await updateTimes(page, eventId, {
      startTime: shiftStart,
      endTime: now,
      breaks: [
        { startTime: rest15Start, endTime: rest15End },
        { startTime: meal30Start, endTime: meal30End },
      ],
    });

    expect(event.breaks).toHaveLength(2);
    expect(event.breaks[0].type).toBe('rest');
    expect(event.breaks[1].type).toBe('meal');

    const shiftSpan = Math.floor((now - shiftStart) / 1000);
    expect(event.accumulatedTime).toBe(shiftSpan - mealDuration);
    expect(event.deductedBreakSeconds).toBe(mealDuration);
    expect(event.totalBreakSeconds).toBe(restDuration + mealDuration);
    expect(event.workSeconds).toBe(shiftSpan - mealDuration);
  });

  // ── Test 5: 2h shift — 10min rest + 25min meal ───────────────────────────

  test('2h shift with 10min rest and 25min meal accumulates correctly', async ({ page }) => {
    const { eventId } = await clockIn(page);

    const now = Date.now();
    const shiftStart = now - 2 * 60 * 60 * 1000; // 2h ago

    const rest10Start = shiftStart + 20 * 60 * 1000;
    const rest10End = rest10Start + 10 * 60 * 1000; // 10 min → rest

    const meal25Start = shiftStart + 60 * 60 * 1000;
    const meal25End = meal25Start + 25 * 60 * 1000; // 25 min → meal

    const restDuration = 10 * 60; // 600s
    const mealDuration = 25 * 60; // 1500s

    const event = await updateTimes(page, eventId, {
      startTime: shiftStart,
      endTime: now,
      breaks: [
        { startTime: rest10Start, endTime: rest10End },
        { startTime: meal25Start, endTime: meal25End },
      ],
    });

    expect(event.breaks).toHaveLength(2);
    expect(event.breaks[0].type).toBe('rest');
    expect(event.breaks[1].type).toBe('meal');

    const shiftSpan = Math.floor((now - shiftStart) / 1000);
    expect(event.accumulatedTime).toBe(shiftSpan - mealDuration);
    expect(event.deductedBreakSeconds).toBe(mealDuration);
    expect(event.totalBreakSeconds).toBe(restDuration + mealDuration);
    expect(event.workSeconds).toBe(shiftSpan - mealDuration);
  });
});
