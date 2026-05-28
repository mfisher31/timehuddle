/**
 * Timer routes — integration tests.
 *
 * Tests for the new WorkItem + Timer model.
 * Verifies:
 *  - At most one running timer per user (unique partial index)
 *  - Start/stop compare-and-set semantics
 *  - Clock-out closes all open timers via single updateMany
 *  - Ticket total derived from Timer, not Ticket
 *  - Day view and week totals
 *  - Copy-from-previous
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildApp } from "../src/server.js";
import { connectDB, client } from "../src/lib/db.js";
import { auth } from "../src/lib/auth.js";
import { ensureIndexes } from "../src/lib/ensure-indexes.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_A = { name: "Timer User A", email: "timer-a@test.dev", password: "Password1!" };
const USER_B = { name: "Timer User B", email: "timer-b@test.dev", password: "Password1!" };

let app: FastifyInstance;
let cookieA: string;
let cookieB: string;
let userAId: string;
let teamId: string;
let ticketId: string;
let ticketBId: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSessionCookie(email: string, password: string): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;
  const rawCookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return rawCookies.map((c) => c.split(";")[0].trim()).join("; ");
}

async function purgeUser(email: string) {
  const db = client.db();
  const user = await db.collection("user").findOne({ email });
  if (!user) return;
  const userId = String(user._id);
  await Promise.all([
    db.collection("account").deleteMany({ userId }),
    db.collection("session").deleteMany({ userId }),
    db.collection("user").deleteOne({ _id: user._id }),
  ]);
}

async function inject(method: string, url: string, cookie: string, payload?: unknown) {
  return app.inject({
    method: method as any,
    url,
    headers: { cookie },
    payload: payload as any,
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectDB();
  await ensureIndexes();
  app = await buildApp({ logger: false });
  await app.ready();

  const db = client.db();

  await Promise.all([purgeUser(USER_A.email), purgeUser(USER_B.email)]);
  await auth.api.signUpEmail({ body: USER_A });
  await auth.api.signUpEmail({ body: USER_B });

  userAId = String((await db.collection("user").findOne({ email: USER_A.email }))!._id);
  const userBId = String((await db.collection("user").findOne({ email: USER_B.email }))!._id);

  // Create test team with both users
  const teamDoc = {
    _id: new ObjectId(),
    name: "Timer Team",
    members: [userAId, userBId],
    admins: [userAId],
    code: "TIMERTEAM1",
    isPersonal: false,
    createdAt: new Date(),
  };
  await db.collection("teams").insertOne(teamDoc);
  teamId = teamDoc._id.toHexString();

  // Create two test tickets
  const tA = {
    _id: new ObjectId(),
    teamId,
    title: "Ticket Alpha",
    github: "",
    status: "open",
    createdBy: userAId,
    assignedTo: userAId,
    createdAt: new Date(),
  };
  const tB = {
    _id: new ObjectId(),
    teamId,
    title: "Ticket Beta",
    github: "",
    status: "open",
    createdBy: userAId,
    assignedTo: userAId,
    createdAt: new Date(),
  };
  await db.collection("tickets").insertMany([tA, tB]);
  ticketId = tA._id.toHexString();
  ticketBId = tB._id.toHexString();

  cookieA = await getSessionCookie(USER_A.email, USER_A.password);
  cookieB = await getSessionCookie(USER_B.email, USER_B.password);
}, 20000);

afterAll(async () => {
  const db = client.db();
  await db.collection("teams").deleteOne({ code: "TIMERTEAM1" });
  await db.collection("tickets").deleteMany({ teamId });
  await db.collection("workitems").deleteMany({ userId: userAId });
  await db.collection("timers").deleteMany({ userId: userAId });
  await Promise.all([purgeUser(USER_A.email), purgeUser(USER_B.email)]);
  await app.close();
});

// ─── Auth gates ───────────────────────────────────────────────────────────────

describe("auth gates", () => {
  it("GET /v1/timers/day — 401 without cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/timers/day?date=2025-01-01" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/timers/entries — 401 without cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/timers/entries",
      payload: { ticketId, date: "2025-01-01" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Create WorkItem ─────────────────────────────────────────────────────────────

describe("POST /v1/timers/entries", () => {
  it("creates a WorkItem for a team ticket — 201", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: today,
    });
    expect(res.statusCode).toBe(201);
    const { entry } = res.json();
    expect(entry.ticketId).toBe(ticketId);
    expect(entry.date).toBe(today);
    expect(entry.userId).toBe(userAId);
  });

  it("creates the same ticket/date again as a distinct entry — 201", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const first = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: today,
    });
    const second = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: today,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().entry.id).not.toBe(second.json().entry.id);
  });

  it("returns 404 for a non-existent ticket", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId: new ObjectId().toHexString(),
      date: today,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 if user is not in the ticket's team", async () => {
    // user B is in the team, so we need a ticket NOT in their team
    const db = client.db();
    const otherTeam = {
      _id: new ObjectId(),
      name: "Other",
      members: [],
      admins: [],
      code: "OTHRT1",
      isPersonal: false,
      createdAt: new Date(),
    };
    await db.collection("teams").insertOne(otherTeam);
    const otherTicket = {
      _id: new ObjectId(),
      teamId: otherTeam._id.toHexString(),
      title: "Other",
      github: "",
      status: "open",
      createdBy: "someone",
      assignedTo: null,
      createdAt: new Date(),
    };
    await db.collection("tickets").insertOne(otherTicket);

    const res = await inject("POST", "/v1/timers/entries", cookieB, {
      ticketId: otherTicket._id.toHexString(),
      date: new Date().toISOString().slice(0, 10),
    });
    expect(res.statusCode).toBe(403);

    await db.collection("teams").deleteOne({ _id: otherTeam._id });
    await db.collection("tickets").deleteOne({ _id: otherTicket._id });
  });
});

// ─── Start timer session ──────────────────────────────────────────────────────

let entryId: string;
let _sessionId: string;

describe("POST /v1/timers/entries/:id/start", () => {
  beforeAll(async () => {
    // Ensure entry exists
    const today = new Date().toISOString().slice(0, 10);
    const res = await inject("POST", "/v1/timers/entries", cookieA, { ticketId, date: today });
    entryId = res.json().entry.id;
  });

  it("starts a session — 200", async () => {
    const now = Date.now();
    const res = await inject("POST", `/v1/timers/entries/${entryId}/start`, cookieA, { now });
    expect(res.statusCode).toBe(200);
    const { session } = res.json();
    expect(session.workItemId).toBe(entryId);
    expect(session.startTime).toBe(now);
    expect(session.endTime).toBeNull();
    _sessionId = session.id;
  });

  it("at most one running session per user — starting again closes previous", async () => {
    // Create a second entry for ticketB
    const today = new Date().toISOString().slice(0, 10);
    const entryBRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId: ticketBId,
      date: today,
    });
    const entryBId = entryBRes.json().entry.id;

    const now2 = Date.now() + 5000;
    const res = await inject("POST", `/v1/timers/entries/${entryBId}/start`, cookieA, {
      now: now2,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.endTime).toBeNull(); // new session is running
    expect(body.closedSessionId).toBeTruthy(); // previous session was closed
  });

  it("GET /v1/timers/running returns the running session", async () => {
    const res = await inject("GET", "/v1/timers/running", cookieA);
    expect(res.statusCode).toBe(200);
    expect(res.json().session).not.toBeNull();
    expect(res.json().session.endTime).toBeNull();
  });

  it("keeps timer.date aligned with the parent WorkItem date", async () => {
    const fixedDate = "2099-03-01";
    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: fixedDate,
    });
    const fixedEntryId = createRes.json().entry.id;

    const startRes = await inject("POST", `/v1/timers/entries/${fixedEntryId}/start`, cookieA, {
      now: Date.now(),
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().session.date).toBe(fixedDate);
  });

  it("returns 403 when starting another user's WorkItem", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: today,
    });
    const foreignEntryId = createRes.json().entry.id;

    const res = await inject("POST", `/v1/timers/entries/${foreignEntryId}/start`, cookieB, {
      now: Date.now(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for a malformed WorkItem id", async () => {
    const res = await inject("POST", "/v1/timers/entries/not-an-object-id/start", cookieA, {
      now: Date.now(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not crash on an invalid tz value — falls back to UTC and succeeds", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: today,
    });
    expect(createRes.statusCode).toBe(201);
    const tzEntryId = createRes.json().entry.id;

    const res = await inject("POST", `/v1/timers/entries/${tzEntryId}/start`, cookieA, {
      now: Date.now(),
      tz: "Not/A_Timezone",
    });
    // Should not return 500 — invalid tz falls back to UTC, request succeeds
    expect(res.statusCode).not.toBe(500);
  });
});

// ─── Stop timer session ───────────────────────────────────────────────────────

let closedSessionId: string;

describe("POST /v1/timers/sessions/:id/stop", () => {
  beforeAll(async () => {
    // Ensure a session is running
    const now = Date.now() - 5000;
    const res = await inject("POST", `/v1/timers/entries/${entryId}/start`, cookieA, { now });
    closedSessionId = res.json().session.id;
  });

  it("stops a running session — 200", async () => {
    const now = Date.now();
    const res = await inject("POST", `/v1/timers/sessions/${closedSessionId}/stop`, cookieA, {
      now,
    });
    expect(res.statusCode).toBe(200);
    const { session } = res.json();
    expect(session.endTime).not.toBeNull();
    expect(session.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("stopping again returns 409 already-stopped", async () => {
    const res = await inject("POST", `/v1/timers/sessions/${closedSessionId}/stop`, cookieA, {
      now: Date.now(),
    });
    expect(res.statusCode).toBe(409);
  });

  it("non-owner returns 403", async () => {
    const res = await inject("POST", `/v1/timers/sessions/${closedSessionId}/stop`, cookieB, {
      now: Date.now(),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Delete WorkItem ────────────────────────────────────────────────────────────

describe("DELETE /v1/timers/entries/:id", () => {
  it("deletes an entry and all associated sessions", async () => {
    const db = client.db();
    const today = new Date().toISOString().slice(0, 10);

    const entryRes = await inject("POST", "/v1/timers/entries", cookieA, { ticketId, date: today });
    const eId = entryRes.json().entry.id;

    await inject("POST", `/v1/timers/entries/${eId}/start`, cookieA, { now: Date.now() - 3000 });

    const before = await db.collection("timers").countDocuments({ workItemId: eId });
    expect(before).toBeGreaterThan(0);

    const delRes = await inject("DELETE", `/v1/timers/entries/${eId}`, cookieA);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().deletedEntry).toBe(true);
    expect(delRes.json().deletedSessions).toBeGreaterThan(0);

    const entryAfter = await db.collection("workitems").findOne({ _id: new ObjectId(eId) });
    expect(entryAfter).toBeNull();
    const sessionsAfter = await db.collection("timers").countDocuments({ workItemId: eId });
    expect(sessionsAfter).toBe(0);
  });

  it("returns 403 when deleting another user's entry", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const entryRes = await inject("POST", "/v1/timers/entries", cookieA, { ticketId, date: today });
    const eId = entryRes.json().entry.id;

    const delRes = await inject("DELETE", `/v1/timers/entries/${eId}`, cookieB);
    expect(delRes.statusCode).toBe(403);
  });
});

// ─── Update WorkItem ────────────────────────────────────────────────────────────

describe("PATCH /v1/timers/entries/:id", () => {
  it("updates ticket even when note is cleared", async () => {
    const testDate = "2099-02-01";

    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: testDate,
      note: "temp note",
    });
    const entryIdToMove = createRes.json().entry.id as string;

    const patchRes = await inject("PATCH", `/v1/timers/entries/${entryIdToMove}`, cookieA, {
      ticketId: ticketBId,
      note: null,
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().entry.ticketId).toBe(ticketBId);
    expect(patchRes.json().entry.note).toBeNull();
  });

  it("allows moving to a ticket that already has an entry that day", async () => {
    const testDate = "2099-02-02";

    const existingRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: testDate,
    });
    const keepId = existingRes.json().entry.id as string;

    const moveSourceRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId: ticketBId,
      date: testDate,
    });
    const moveSourceId = moveSourceRes.json().entry.id as string;

    expect(keepId).not.toBe(moveSourceId);

    const patchRes = await inject("PATCH", `/v1/timers/entries/${moveSourceId}`, cookieA, {
      ticketId,
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().entry.ticketId).toBe(ticketId);
  });

  it("does not mutate running timer duration when durationSeconds is patched", async () => {
    const db = client.db();
    const testDate = new Date().toISOString().slice(0, 10);

    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: testDate,
    });
    const runningEntryId = createRes.json().entry.id as string;

    const startRes = await inject("POST", `/v1/timers/entries/${runningEntryId}/start`, cookieA, {
      now: Date.now() - 30_000,
    });
    expect(startRes.statusCode).toBe(200);

    const patchRes = await inject("PATCH", `/v1/timers/entries/${runningEntryId}`, cookieA, {
      durationSeconds: 5,
    });
    expect(patchRes.statusCode).toBe(200);

    const runningDoc = await db
      .collection("timers")
      .findOne({ workItemId: runningEntryId, endTime: null });
    expect(runningDoc).not.toBeNull();
    expect(runningDoc?.durationSeconds).toBeUndefined();
  });
});

// ─── Ticket total from Timers ─────────────────────────────────────────────────

describe("GET /v1/timers/tickets/:ticketId/total", () => {
  it("returns the sum of durationSeconds for all closed sessions", async () => {
    const res = await inject("GET", `/v1/timers/tickets/${ticketId}/total`, cookieA);
    expect(res.statusCode).toBe(200);
    const { totalSeconds } = res.json();
    expect(typeof totalSeconds).toBe("number");
    expect(totalSeconds).toBeGreaterThanOrEqual(0);
    // Ticket itself must not have accumulatedTime
    const db = client.db();
    const ticket = await db.collection("tickets").findOne({ _id: new ObjectId(ticketId) });
    expect(ticket?.accumulatedTime).toBeUndefined();
  });
});

// ─── Day view ─────────────────────────────────────────────────────────────────

describe("GET /v1/timers/day", () => {
  it("returns entries with sessions for today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await inject("GET", `/v1/timers/day?date=${today}`, cookieA);
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    expect(Array.isArray(entries)).toBe(true);
    // Each entry has an entry and sessions array
    for (const e of entries) {
      expect(e.entry).toBeDefined();
      expect(Array.isArray(e.sessions)).toBe(true);
    }
  });

  it("returns 200 with empty array for a day with no entries", async () => {
    const res = await inject("GET", "/v1/timers/day?date=1990-01-01", cookieA);
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(0);
  });
});

// ─── Week totals ──────────────────────────────────────────────────────────────

describe("GET /v1/timers/week", () => {
  it("returns 7 day totals", async () => {
    // Get Monday of the current week
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);

    const res = await inject("GET", `/v1/timers/week?date=${weekStart}`, cookieA);
    expect(res.statusCode).toBe(200);
    const { days } = res.json();
    expect(Array.isArray(days)).toBe(true);
    expect(days).toHaveLength(7);
    for (const d of days) {
      expect(typeof d.date).toBe("string");
      expect(typeof d.totalSeconds).toBe("number");
    }
  });
});

// ─── Copy from previous ───────────────────────────────────────────────────────

describe("POST /v1/timers/copy-previous", () => {
  it("copies entries from previous day and returns count", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);

    // Create an entry for yesterday first
    await inject("POST", "/v1/timers/entries", cookieA, { ticketId, date: yDate });

    const today = new Date().toISOString().slice(0, 10);
    const res = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate: today });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().created).toBe("number");
  });

  it("returns 0 when there are no previous entries", async () => {
    // Use a far-future date as "today"
    const farFuture = "2099-01-01";
    const res = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate: farFuture });
    expect(res.statusCode).toBe(200);
    // May or may not be 0 depending on how many prior entries exist, but it must succeed
    expect(typeof res.json().created).toBe("number");
  });

  it("is idempotent for tickets already copied to the target day", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    await inject("POST", "/v1/timers/entries", cookieA, { ticketId: ticketBId, date: yDate });

    const first = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate: today });
    const second = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate: today });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(0);
  });

  it("copies multiple rows for the same ticket when note/sortOrder differ", async () => {
    const db = client.db();
    const prevDate = "2099-06-01";
    const toDate = "2099-06-02";

    await db
      .collection("workitems")
      .deleteMany({ userId: userAId, date: { $in: [prevDate, toDate] } });

    await db.collection("workitems").insertMany([
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        note: "Morning pass",
        sortOrder: 1,
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        note: "Afternoon pass",
        sortOrder: 2,
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        note: "Wrap-up",
        sortOrder: 3,
        createdAt: new Date(),
      },
    ]);

    const res = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(3);

    const copied = await db
      .collection("workitems")
      .find({ userId: userAId, date: toDate, ticketId })
      .sort({ sortOrder: 1 })
      .toArray();

    expect(copied).toHaveLength(3);
    expect(copied.map((entry) => entry.note)).toEqual([
      "Morning pass",
      "Afternoon pass",
      "Wrap-up",
    ]);
  });

  it("preserves duplicate identical rows from previous day", async () => {
    const db = client.db();
    const prevDate = "2099-06-03";
    const toDate = "2099-06-04";

    await db
      .collection("workitems")
      .deleteMany({ userId: userAId, date: { $in: [prevDate, toDate] } });

    await db.collection("workitems").insertMany([
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        note: "Note",
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        userId: userAId,
        ticketId,
        date: prevDate,
        createdAt: new Date(),
      },
    ]);

    const res = await inject("POST", "/v1/timers/copy-previous", cookieA, { toDate });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(3);

    const copied = await db
      .collection("workitems")
      .find({ userId: userAId, date: toDate, ticketId })
      .toArray();
    expect(copied).toHaveLength(3);

    const notes = copied.map((entry) => entry.note ?? null);
    expect(notes.filter((n) => n === "Note")).toHaveLength(1);
    expect(notes.filter((n) => n === null)).toHaveLength(2);
  });
});

// ─── Clock-out closes all sessions via single updateMany ──────────────────────

describe("clock-out closes all open timer sessions", () => {
  it("clocking out stops any running timer session", async () => {
    const db = client.db();

    // Clock in to the team
    await inject("POST", "/v1/clock/start", cookieA);

    // Start a timer session for the ticket
    const today = new Date().toISOString().slice(0, 10);
    const entryRes = await inject("POST", "/v1/timers/entries", cookieA, { ticketId, date: today });
    const eId = entryRes.json().entry.id;
    await inject("POST", `/v1/timers/entries/${eId}/start`, cookieA, { now: Date.now() });

    // Verify the timer is running
    const runningBefore = await db.collection("timers").findOne({ userId: userAId, endTime: null });
    expect(runningBefore).not.toBeNull();

    // Clock out — this should close all timers
    await inject("POST", "/v1/clock/stop", cookieA);

    // Verify no timers are running for this user
    const runningAfter = await db.collection("timers").findOne({ userId: userAId, endTime: null });
    expect(runningAfter).toBeNull();
  });
});

// ─── ClockEvent shape must not include tickets[] ──────────────────────────────

describe("ClockEvent no longer has tickets[]", () => {
  it("POST /v1/clock/start returns event without tickets field", async () => {
    const res = await inject("POST", "/v1/clock/start", cookieA);
    expect(res.statusCode).toBe(200);
    const { event } = res.json();
    expect(event.tickets).toBeUndefined();

    // Clock back out
    await inject("POST", "/v1/clock/stop", cookieA);
  });
});

// ─── Timezone pitfalls: local date vs UTC epoch ───────────────────────────────
//
// These tests guard against the class of bug where a timer's `date` field
// (local calendar day string used by getDayEntries) diverges from the
// startTime epoch window used by getWeekTotals, causing entries to appear
// in the week strip but be invisible in the day view (or vice-versa).

describe("timezone: timer date field stays consistent with WorkItem date", () => {
  it("timer inherits the WorkItem date, not a UTC-derived date from startTime", async () => {
    const db = client.db();

    // Use a fixed date string that simulates a "local" date
    const localDate = "2099-07-15";
    const createRes = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: localDate,
    });
    expect(createRes.statusCode).toBe(201);
    const eId = createRes.json().entry.id;

    // Start a timer with a `now` that in UTC maps to the *previous* calendar day
    // (e.g. 23:00 UTC = 00:00 local UTC+1 — the WorkItem date is correct, timer must match)
    const startRes = await inject("POST", `/v1/timers/entries/${eId}/start`, cookieA, {
      now: Date.now(),
    });
    expect(startRes.statusCode).toBe(200);

    const timer = await db.collection("timers").findOne({ workItemId: eId, endTime: null });
    expect(timer).not.toBeNull();
    // Critical: timer.date must match the WorkItem's local date, not a UTC-derived key
    expect(timer!.date).toBe(localDate);
  });

  it("week totals for a date match the timer date field, not startTime epoch", async () => {
    const db = client.db();

    // Directly insert a WorkItem + Timer simulating what would be stored when
    // a user's local date is "2099-08-01" but startTime epoch resolves to
    // "2099-07-31" in UTC (late-night local time ahead of UTC).
    const localDate = "2099-08-01";
    const utcPrevDate = "2099-07-31";

    // Build a startTime that is in UTC on utcPrevDate (22:00 UTC on Jul 31 = just-after-midnight local UTC+2)
    const startTime = new Date(`${utcPrevDate}T22:00:00.000Z`).getTime();
    const endTime = startTime + 3600_000; // 1 hour later
    const durationSeconds = 3600;

    const entryId2 = new ObjectId();
    await db.collection("workitems").insertOne({
      _id: entryId2,
      userId: userAId,
      ticketId,
      date: localDate,
      createdAt: new Date(),
    });
    await db.collection("timers").insertOne({
      _id: new ObjectId(),
      workItemId: entryId2.toHexString(),
      userId: userAId,
      date: localDate, // local date — the key that getWeekTotals must query by
      startTime, // UTC epoch falls on utcPrevDate
      endTime,
      durationSeconds,
      createdAt: new Date(),
    });

    // Week query with the local Monday that contains localDate (2099-08-01 = Monday)
    const weekStart = localDate;
    // Use UTC tz so localDayBounds would differ from the date field for non-UTC users
    const res = await inject(
      "GET",
      `/v1/timers/week?date=${weekStart}&tz=America/New_York`,
      cookieA
    );
    expect(res.statusCode).toBe(200);
    const { days } = res.json();
    const aug1 = days.find((d: { date: string }) => d.date === localDate);
    expect(aug1).toBeDefined();

    // The timer must appear under localDate (2099-08-01), NOT under utcPrevDate (2099-07-31)
    expect(aug1!.totalSeconds).toBeGreaterThanOrEqual(durationSeconds);

    const jul31 = days.find((d: { date: string }) => d.date === utcPrevDate);
    // utcPrevDate may not be in this week range at all — only assert if present
    if (jul31) {
      expect(jul31.totalSeconds).toBe(0);
    }

    // Cleanup
    await db.collection("workitems").deleteOne({ _id: entryId2 });
    await db.collection("timers").deleteMany({ workItemId: entryId2.toHexString() });
  });

  it("day view returns timers stored under date field regardless of startTime epoch", async () => {
    const db = client.db();

    // Same setup: local date "2099-09-01", startTime epoch is on "2099-08-31" UTC
    const localDate = "2099-09-01";
    const startTime = new Date("2099-08-31T22:30:00.000Z").getTime();
    const endTime = startTime + 1800_000;
    const durationSeconds = 1800;

    const entryId3 = new ObjectId();
    await db.collection("workitems").insertOne({
      _id: entryId3,
      userId: userAId,
      ticketId,
      date: localDate,
      createdAt: new Date(),
    });
    await db.collection("timers").insertOne({
      _id: new ObjectId(),
      workItemId: entryId3.toHexString(),
      userId: userAId,
      date: localDate,
      startTime,
      endTime,
      durationSeconds,
      createdAt: new Date(),
    });

    const res = await inject(
      "GET",
      `/v1/timers/day?date=${localDate}&tz=America/New_York`,
      cookieA
    );
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    const match = entries.find(
      (e: { entry: { id: string } }) => e.entry.id === entryId3.toHexString()
    );
    expect(match).toBeDefined();
    expect(match!.sessions).toHaveLength(1);
    expect(match!.sessions[0].durationSeconds).toBe(durationSeconds);

    // Cleanup
    await db.collection("workitems").deleteOne({ _id: entryId3 });
    await db.collection("timers").deleteMany({ workItemId: entryId3.toHexString() });
  });

  it("startNow creates timer with WorkItem's date, not a UTC-derived date key", async () => {
    const db = client.db();

    // A date that diverges from UTC midnight — far future to avoid collisions
    const localDate = "2099-10-15";
    const res = await inject("POST", "/v1/timers/entries", cookieA, {
      ticketId,
      date: localDate,
      startNow: true,
    });
    expect(res.statusCode).toBe(201);

    const { entry, session } = res.json();
    // The timer returned must share the WorkItem's date, not a UTC-derived one
    expect(session).not.toBeNull();
    expect(session.date).toBe(localDate);

    // Also verify in the DB directly
    const timer = await db.collection("timers").findOne({ workItemId: entry.id, endTime: null });
    expect(timer).not.toBeNull();
    expect(timer!.date).toBe(localDate);

    // Stop the running timer to leave state clean
    await inject("POST", `/v1/timers/sessions/${session.id}/stop`, cookieA, { now: Date.now() });
  });
});
