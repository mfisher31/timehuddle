/**
 * Clock routes — integration tests.
 *
 * Fixture setup (beforeAll):
 *  - WORKER  : clocks in/out, owns the clock events
 *  - ADMIN   : team admin (can adjust times)
 *  - OTHER   : not in the team
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildApp } from "../src/server.js";
import { connectDB, client } from "../src/lib/db.js";
import { auth } from "../src/lib/auth.js";
import { clockMonitorService } from "../src/services/clock-monitor.service.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKER = { name: "Clock Worker", email: "clock-worker@test.dev", password: "Password1!" };
const ADMIN = { name: "Clock Admin", email: "clock-admin@test.dev", password: "Password1!" };
const OTHER = { name: "Clock Other", email: "clock-other@test.dev", password: "Password1!" };

let app: FastifyInstance;
let workerCookie: string;
let adminCookie: string;
let otherCookie: string;
let workerId: string;
let adminId: string;
let clockEventId: string;

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

async function inject(
  method: string,
  url: string,
  cookie: string,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method: method as any,
    url,
    headers: { cookie },
    payload,
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectDB();
  app = await buildApp({ logger: false });
  await app.ready();

  const db = client.db();

  await Promise.all([purgeUser(WORKER.email), purgeUser(ADMIN.email), purgeUser(OTHER.email)]);

  await auth.api.signUpEmail({ body: WORKER });
  await auth.api.signUpEmail({ body: ADMIN });
  await auth.api.signUpEmail({ body: OTHER });

  workerId = String((await db.collection("user").findOne({ email: WORKER.email }))!._id);
  adminId = String((await db.collection("user").findOne({ email: ADMIN.email }))!._id);

  // Create test team
  const teamDoc = {
    _id: new ObjectId(),
    name: "Clock Team",
    members: [workerId, adminId],
    admins: [adminId],
    code: "CLOCKTEAM1",
    isPersonal: false,
    createdAt: new Date(),
  };
  await db.collection("teams").insertOne(teamDoc);

  workerCookie = await getSessionCookie(WORKER.email, WORKER.password);
  adminCookie = await getSessionCookie(ADMIN.email, ADMIN.password);
  otherCookie = await getSessionCookie(OTHER.email, OTHER.password);
}, 20000);

afterAll(async () => {
  const db = client.db();
  await db.collection("teams").deleteOne({ code: "CLOCKTEAM1" });
  await db.collection("clockevents").deleteMany({ userId: workerId });
  await db.collection("clockevents").deleteMany({ userId: adminId });
  await db.collection("clockevents").deleteMany({
    userId: String((await db.collection("user").findOne({ email: OTHER.email }))?._id ?? ""),
  });
  await db.collection("notifications").deleteMany({ userId: workerId });
  await db.collection("timers").deleteMany({ userId: workerId });
  await db.collection("workitems").deleteMany({ userId: workerId });
  await Promise.all([purgeUser(WORKER.email), purgeUser(ADMIN.email), purgeUser(OTHER.email)]);
  await app.close();
});

// ─── Auth gates ───────────────────────────────────────────────────────────────

describe("auth gate", () => {
  it("POST /v1/clock/start — 401 without cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/clock/start",
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/clock/stop — 401 without cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/clock/stop",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── POST /v1/clock/start ─────────────────────────────────────────────────────

describe("POST /v1/clock/start", () => {
  it("clocks in — 200, returns event", async () => {
    const res = await inject("POST", "/v1/clock/start", workerCookie);
    expect(res.statusCode).toBe(200);
    const { event } = res.json();
    expect(event.userId).toBe(workerId);
    expect(event.endTime).toBeNull();
    expect(typeof event.startTime).toBe("number");
    clockEventId = event.id;
  });

  it("clocking in again closes the previous event and opens a new one", async () => {
    const res = await inject("POST", "/v1/clock/start", workerCookie);
    expect(res.statusCode).toBe(200);
    const { event } = res.json();
    expect(event.id).not.toBe(clockEventId);
    clockEventId = event.id; // use the latest one
  });

  it("allows any authenticated user to clock in", async () => {
    const res = await inject("POST", "/v1/clock/start", otherCookie);
    expect(res.statusCode).toBe(200);
    await inject("POST", "/v1/clock/stop", otherCookie);
  });
});

// ─── GET /v1/clock/active ─────────────────────────────────────────────────────

describe("GET /v1/clock/active", () => {
  it("returns the active event for worker — 200", async () => {
    const res = await inject("GET", "/v1/clock/active", workerCookie);
    expect(res.statusCode).toBe(200);
    const { event } = res.json();
    expect(event.id).toBe(clockEventId);
    expect(event.endTime).toBeNull();
  });

  it("returns null when user has no active event — 200", async () => {
    const res = await inject("GET", "/v1/clock/active", adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBeNull();
  });
});

// ─── Pause / Resume / Status ────────────────────────────────────────────────

describe("clock break flow", () => {
  it("pauses and resumes an active clock event", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);

    const pauseRes = await inject("POST", "/v1/clock/pause", workerCookie);
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().event.isPaused).toBe(true);
    expect(Array.isArray(pauseRes.json().event.breaks)).toBe(true);
    expect(pauseRes.json().event.breaks.length).toBeGreaterThan(0);
    expect(pauseRes.json().event.breaks[0].endTime).toBeNull();

    const statusWhilePaused = await inject("GET", `/v1/clock/status`, workerCookie);
    expect(statusWhilePaused.statusCode).toBe(200);
    expect(statusWhilePaused.json().isPaused).toBe(true);

    const resumeRes = await inject("POST", "/v1/clock/resume", workerCookie);
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().event.isPaused).toBe(false);
    expect(Array.isArray(resumeRes.json().event.breaks)).toBe(true);
    expect(resumeRes.json().event.breaks[0].endTime).not.toBeNull();

    const statusAfterResume = await inject("GET", `/v1/clock/status`, workerCookie);
    expect(statusAfterResume.statusCode).toBe(200);
    expect(statusAfterResume.json().isPaused).toBe(false);

    const stopRes = await inject("POST", "/v1/clock/stop", workerCookie);
    expect(stopRes.statusCode).toBe(200);
  });

  it("returns 409 when pausing an already paused clock", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);

    const firstPause = await inject("POST", "/v1/clock/pause", workerCookie);
    expect(firstPause.statusCode).toBe(200);

    const secondPause = await inject("POST", "/v1/clock/pause", workerCookie);
    expect(secondPause.statusCode).toBe(409);

    await inject("POST", "/v1/clock/stop", workerCookie);
  });
});

// ─── Monitor enforcement ─────────────────────────────────────────────────────

describe("clock monitor enforcement", () => {
  it("sends a one-time 4h reminder", async () => {
    const db = client.db();
    await db.collection("notifications").deleteMany({ userId: workerId });

    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const eventId = startRes.json().event.id as string;

    await db.collection("clockevents").updateOne(
      { _id: new ObjectId(eventId) },
      {
        $set: {
          // Set startTime to 4.5 hours ago so computeWorkSeconds returns > 4h
          startTime: Date.now() - 4.5 * 60 * 60 * 1000,
          notifiedAt4h: null,
        },
      }
    );

    const firstRun = await clockMonitorService.checkAndEnforce(Date.now());
    expect(firstRun.reminded4h).toBeGreaterThanOrEqual(1);

    const secondRun = await clockMonitorService.checkAndEnforce(Date.now());
    expect(secondRun.reminded4h).toBe(0);

    const reminders = await db
      .collection("notifications")
      .find({ userId: workerId, "data.type": "break-reminder-4h" })
      .toArray();
    expect(reminders.length).toBe(1);

    await inject("POST", "/v1/clock/stop", workerCookie);
  });
});

// ─── Attachments (replaces YouTube-specific route) ───────────────────────────

describe("POST /v1/attachments (clock)", () => {
  it("adds a link attachment to a clock entry — 201", async () => {
    const res = await inject("POST", "/v1/attachments", workerCookie, {
      url: "https://youtube.com/shorts/abc123",
      type: "video",
      title: "My session recording",
      attachedTo: { kind: "clock", id: clockEventId },
    });
    expect(res.statusCode).toBe(201);
    const { attachment } = res.json();
    expect(attachment.url).toBe("https://youtube.com/shorts/abc123");
    expect(attachment.type).toBe("video");
    expect(attachment.attachedTo.kind).toBe("clock");
    expect(attachment.attachedTo.id).toBe(clockEventId);
  });

  it("lists attachments for a clock entry — 200", async () => {
    const res = await inject("GET", `/v1/attachments?kind=clock&id=${clockEventId}`, workerCookie);
    expect(res.statusCode).toBe(200);
    const { attachments } = res.json();
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments.length).toBeGreaterThan(0);
  });
});

// ─── POST /v1/clock/stop ──────────────────────────────────────────────────────

describe("POST /v1/clock/stop", () => {
  it("clocks out — 200, sets endTime", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);

    const res = await inject("POST", "/v1/clock/stop", workerCookie);
    expect(res.statusCode).toBe(200);
    const { event } = res.json();
    expect(event.endTime).not.toBeNull();
    expect(event.accumulatedTime).toBeGreaterThanOrEqual(0);
  });

  it("active event is null after clocking out", async () => {
    const res = await inject("GET", "/v1/clock/active", workerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBeNull();
  });

  it("returns 404 when already clocked out", async () => {
    const res = await inject("POST", "/v1/clock/stop", workerCookie);
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /v1/clock/events ─────────────────────────────────────────────────────

describe("GET /v1/clock/events", () => {
  it("returns all events for the worker — 200", async () => {
    const res = await inject("GET", "/v1/clock/events", workerCookie);
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].userId).toBe(workerId);
  });
});

// ─── PUT /v1/clock/:id/times ─────────────────────────────────────────────────

describe("PUT /v1/clock/:id/times", () => {
  it("admin can adjust start time — 200", async () => {
    const newStart = Date.now() - 3600_000; // 1 hour ago
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      startTime: newStart,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event.startTime).toBe(newStart);
  });

  it("event owner can adjust times — 200", async () => {
    const base = Date.now() - 120_000;
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, workerCookie, {
      startTime: base,
      endTime: base + 60_000,
    });
    expect(res.statusCode).toBe(200);
  });

  it("non-owner non-admin returns 403", async () => {
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, otherCookie, {
      startTime: Date.now(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 422 if endTime < startTime", async () => {
    const now = Date.now();
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      startTime: now,
      endTime: now - 1000,
    });
    expect(res.statusCode).toBe(422);
  });

  it("returns 422 when only startTime is moved past existing endTime", async () => {
    // First set a known startTime + endTime pair
    const base = Date.now() - 3600_000;
    await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      startTime: base,
      endTime: base + 1000,
    });
    // Now move startTime past the stored endTime
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      startTime: base + 5000,
    });
    expect(res.statusCode).toBe(422);
  });

  it("returns 422 when only endTime is set before existing startTime", async () => {
    // First set a known startTime
    const base = Date.now() - 3600_000;
    await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      startTime: base,
      endTime: base + 10_000,
    });
    // Now move endTime before the stored startTime
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      endTime: base - 1000,
    });
    expect(res.statusCode).toBe(422);
  });

  it("shrinks overlapping break periods and recalculates totals on edit", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const eventId = startRes.json().event.id as string;

    const db = client.db();
    const base = Date.now() - 2 * 60 * 60 * 1000;
    const sessionEnd = base + 90 * 60 * 1000; // 90 min
    const breakStart = base + 30 * 60 * 1000; // +30 min
    const breakEnd = base + 60 * 60 * 1000; // +60 min

    await db.collection("clockevents").updateOne(
      { _id: new ObjectId(eventId) },
      {
        $set: {
          startTime: base,
          endTime: sessionEnd,
          accumulatedTime: 60 * 60,
        },
      }
    );
    // Seed the break in the separate clockbreaks collection (embedded field no longer exists)
    await db.collection("clockbreaks").insertOne({
      _id: new ObjectId(),
      clockEventId: eventId,
      startTime: breakStart,
      endTime: breakEnd,
    });

    const editedEnd = base + 45 * 60 * 1000; // overlaps break; break should shrink to +30..+45
    const editRes = await inject("PUT", `/v1/clock/${eventId}/times`, workerCookie, {
      endTime: editedEnd,
    });
    expect(editRes.statusCode).toBe(200);

    const updated = editRes.json().event;
    expect(updated.breaks.length).toBe(1);
    expect(updated.breaks[0].startTime).toBe(breakStart);
    expect(updated.breaks[0].endTime).toBe(editedEnd);
    // 15-min break is classified as "rest" (< 20 min) — not deducted from pay
    expect(updated.breaks[0].type).toBe("rest");
    expect(updated.accumulatedTime).toBe(45 * 60); // full 45-min span, nothing deducted
  });

  it("accepts manual break edits and recalculates session totals", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const eventId = startRes.json().event.id as string;

    const base = Date.now() - 2 * 60 * 60 * 1000;
    const sessionEnd = base + 90 * 60 * 1000; // 90 min
    const breakStart = base + 20 * 60 * 1000;
    const breakEnd = base + 30 * 60 * 1000;

    const editRes = await inject("PUT", `/v1/clock/${eventId}/times`, workerCookie, {
      startTime: base,
      endTime: sessionEnd,
      breaks: [{ startTime: breakStart, endTime: breakEnd }],
    });
    expect(editRes.statusCode).toBe(200);

    const updated = editRes.json().event;
    expect(updated.breaks.length).toBe(1);
    expect(updated.breaks[0].startTime).toBe(breakStart);
    expect(updated.breaks[0].endTime).toBe(breakEnd);
    // 10-min break is classified as "rest" (< 20 min) — not deducted from pay
    expect(updated.breaks[0].type).toBe("rest");
    expect(updated.accumulatedTime).toBe(90 * 60); // full 90-min span, nothing deducted
  });

  it("clearing endTime (null) always succeeds regardless of startTime", async () => {
    const res = await inject("PUT", `/v1/clock/${clockEventId}/times`, adminCookie, {
      endTime: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event.endTime).toBeNull();
  });
});

// ─── DELETE /v1/clock/:id ───────────────────────────────────────────────────

describe("DELETE /v1/clock/:id", () => {
  it("event owner can delete a clock event — 200", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const ownedEventId = startRes.json().event.id as string;

    const deleteRes = await inject("DELETE", `/v1/clock/${ownedEventId}`, workerCookie);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);
  });

  it("team admin can delete another member's clock event — 200", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const targetEventId = startRes.json().event.id as string;

    const deleteRes = await inject("DELETE", `/v1/clock/${targetEventId}`, adminCookie);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);
  });

  it("non-owner non-admin returns 403", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const targetEventId = startRes.json().event.id as string;

    const forbiddenRes = await inject("DELETE", `/v1/clock/${targetEventId}`, otherCookie);
    expect(forbiddenRes.statusCode).toBe(403);

    // Cleanup to keep test data stable for later assertions.
    await inject("DELETE", `/v1/clock/${targetEventId}`, workerCookie);
  });
});

// ─── GET /v1/clock/timesheet ─────────────────────────────────────────────────

describe("GET /v1/clock/timesheet", () => {
  it("worker can view their own timesheet — 200", async () => {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${workerId}&startMs=${startMs}&endMs=${endMs}`,
      workerCookie
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.summary.totalSessions).toBeGreaterThan(0);
  });

  it("includes live elapsed time for an active session in summary totals", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const activeEventId = startRes.json().event.id as string;

    const db = client.db();
    const twoMinutesAgo = Date.now() - 120_000;
    const eventDate = new Date(twoMinutesAgo);
    await db
      .collection("clockevents")
      .updateOne(
        { _id: new ObjectId(activeEventId) },
        { $set: { startTime: twoMinutesAgo, accumulatedTime: 30 } }
      );

    // Anchor the query window to the adjusted startTime day to avoid midnight flakiness in CI.
    const startMs = new Date(eventDate).setHours(0, 0, 0, 0);
    const endMs = new Date(eventDate).setHours(23, 59, 59, 999);
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${workerId}&startMs=${startMs}&endMs=${endMs}`,
      workerCookie
    );

    expect(res.statusCode).toBe(200);
    const minLiveSeconds = Math.max(0, Math.floor((Date.now() - twoMinutesAgo) / 1000) - 2);
    expect(res.json().summary.totalSeconds).toBeGreaterThanOrEqual(minLiveSeconds);

    await inject("POST", "/v1/clock/stop", workerCookie);
  });

  it("includes a completed session that spans a midnight boundary", async () => {
    const startRes = await inject("POST", "/v1/clock/start", workerCookie);
    expect(startRes.statusCode).toBe(200);
    const crossMidnightEventId = startRes.json().event.id as string;

    const db = client.db();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const yesterdayMidnight = todayStart - 24 * 60 * 60 * 1000;
    const startTime = yesterdayMidnight - 2 * 60 * 1000;
    const endTime = yesterdayMidnight + 3 * 60 * 1000;

    await db
      .collection("clockevents")
      .updateOne(
        { _id: new ObjectId(crossMidnightEventId) },
        { $set: { startTime, endTime, accumulatedTime: 0 } }
      );

    const startMs = yesterdayMidnight - 60 * 60 * 1000;
    const endMs = yesterdayMidnight + 60 * 60 * 1000;
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${workerId}&startMs=${startMs}&endMs=${endMs}`,
      workerCookie
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.totalSeconds).toBeGreaterThanOrEqual(300);
    expect(body.sessions.some((s: { id: string }) => s.id === crossMidnightEventId)).toBe(true);
  });

  it("admin can view worker timesheet (shared team) — 200", async () => {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${workerId}&startMs=${startMs}&endMs=${endMs}`,
      adminCookie
    );
    expect(res.statusCode).toBe(200);
  });

  it("non-admin team member cannot view another member timesheet — 403", async () => {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${adminId}&startMs=${startMs}&endMs=${endMs}`,
      workerCookie
    );
    expect(res.statusCode).toBe(403);
  });

  it("other user gets 403", async () => {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    const res = await inject(
      "GET",
      `/v1/clock/timesheet?userId=${workerId}&startMs=${startMs}&endMs=${endMs}`,
      otherCookie
    );
    expect(res.statusCode).toBe(403);
  });
});
