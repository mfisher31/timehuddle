import { ObjectId } from "mongodb";

import {
  attachmentsCollection,
  clockBreaksCollection,
  clockEventsCollection,
  teamsCollection,
} from "../models/index.js";
import type { ClockBreak, ClockBreakInterval, ClockEvent } from "../models/clock.model.js";
import {
  findActiveClockEventByUser,
  findBreaksForEvent,
  findBreaksForEvents,
  findClockEventsForUser,
} from "../models/clock.model.js";
import { timerService } from "./timer.service.js";

/** 20-minute threshold: breaks ≥ this are non-compensable meal breaks (deducted). */
const MEAL_BREAK_THRESHOLD_SECONDS = 20 * 60;

function isValidId(id: string): boolean {
  return /^[0-9a-f]{24}$/i.test(id);
}

/**
 * Parse raw break input (from API body) into typed ClockBreakInterval entries.
 * Preserves all metadata fields; strips invalid entries; sorts by startTime.
 */
export function toBreakEntries(value: unknown): ClockBreakInterval[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ClockBreakInterval | null => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const startTime = raw["startTime"];
      if (typeof startTime !== "number") return null;
      const endTime = typeof raw["endTime"] === "number" ? raw["endTime"] : null;
      const type = raw["type"] === "rest" || raw["type"] === "meal" ? raw["type"] : undefined;
      const classificationSource =
        raw["classificationSource"] === "auto" || raw["classificationSource"] === "manual"
          ? (raw["classificationSource"] as "auto" | "manual")
          : undefined;
      const notes = typeof raw["notes"] === "string" ? raw["notes"] : undefined;
      const updatedBy = typeof raw["updatedBy"] === "string" ? raw["updatedBy"] : undefined;
      const updatedAt = typeof raw["updatedAt"] === "number" ? raw["updatedAt"] : undefined;
      return { startTime, endTime, type, classificationSource, notes, updatedBy, updatedAt };
    })
    .filter((e): e is ClockBreakInterval => e !== null)
    .sort((a, b) => a.startTime - b.startTime);
}

/** Auto-classify a break based on its duration. */
function classifyBreak(durationSeconds: number): {
  type: "rest" | "meal";
  classificationSource: "auto";
} {
  return {
    type: durationSeconds >= MEAL_BREAK_THRESHOLD_SECONDS ? "meal" : "rest",
    classificationSource: "auto",
  };
}

/**
 * Seconds to deduct from shift span for pay purposes.
 * Only closed "meal" breaks or open breaks exceeding the threshold are deducted.
 */
function computeDeductedBreakSeconds(breaks: ClockBreakInterval[], now: number): number {
  return breaks.reduce((sum, b) => {
    const end = typeof b.endTime === "number" ? b.endTime : now;
    if (end <= b.startTime) return sum;
    const durationSeconds = Math.floor((end - b.startTime) / 1000);
    if (typeof b.endTime === "number") {
      return b.type === "rest" ? sum : sum + durationSeconds;
    }
    return durationSeconds >= MEAL_BREAK_THRESHOLD_SECONDS ? sum + durationSeconds : sum;
  }, 0);
}

/** Total break seconds across all breaks (for display, not pay deduction). */
function computeTotalBreakSeconds(breaks: ClockBreakInterval[], now: number): number {
  return breaks.reduce((sum, b) => {
    const end = typeof b.endTime === "number" ? b.endTime : now;
    if (end <= b.startTime) return sum;
    return sum + Math.floor((end - b.startTime) / 1000);
  }, 0);
}

/**
 * Compute net work seconds for a shift: full span minus deducted (meal) break seconds.
 * No artificial cap — stores the actual hours worked.
 */
export function computeWorkSeconds(
  event: Pick<ClockEvent, "startTime" | "endTime">,
  breaks: ClockBreakInterval[],
  now: number
): number {
  const shiftEnd = typeof event.endTime === "number" ? event.endTime : now;
  const shiftSpan = Math.max(0, Math.floor((shiftEnd - event.startTime) / 1000));
  return Math.max(0, shiftSpan - computeDeductedBreakSeconds(breaks, now));
}

function normalizeBreakEntries(
  breaks: ClockBreakInterval[],
  sessionStart: number,
  sessionEnd: number | null
): ClockBreakInterval[] {
  const clipped = breaks
    .map((b): ClockBreakInterval | null => {
      const start = Math.max(sessionStart, b.startTime);
      const endCap = sessionEnd ?? null;
      const rawEnd = b.endTime;
      const end =
        typeof rawEnd === "number" ? (endCap === null ? rawEnd : Math.min(rawEnd, endCap)) : endCap;

      if (sessionEnd !== null && start >= sessionEnd) return null;
      if (typeof end === "number" && end <= sessionStart) return null;
      if (typeof end === "number" && end <= start) return null;
      return { ...b, startTime: start, endTime: end };
    })
    .filter((b): b is ClockBreakInterval => b !== null)
    .sort((a, b) => a.startTime - b.startTime);

  if (!clipped.length) return [];
  const merged: ClockBreakInterval[] = [];
  for (const current of clipped) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...current });
      continue;
    }
    const prevEnd = prev.endTime;
    const currEnd = current.endTime;
    const overlap = prevEnd === null || current.startTime <= prevEnd;
    if (!overlap) {
      merged.push({ ...current });
      continue;
    }
    if (prevEnd === null) continue;
    if (currEnd === null) {
      prev.endTime = null;
      continue;
    }
    prev.endTime = Math.max(prevEnd, currEnd);
  }
  return merged;
}

// ─── SSE broadcast ────────────────────────────────────────────────────────────

type SseListener = (userId: string, event: PublicClockEvent | null) => void;
const sseListeners = new Set<SseListener>();

export function subscribe(fn: SseListener): () => void {
  sseListeners.add(fn);
  return () => sseListeners.delete(fn);
}

function broadcast(userId: string, event: PublicClockEvent | null) {
  for (const fn of sseListeners) fn(userId, event);
}

// ─── Public shape ─────────────────────────────────────────────────────────────

export function toPublicClockEvent(e: ClockEvent, breaks: ClockBreakInterval[]) {
  // Backwards-compat: documents created before the startTimestamp→startTime rename
  const raw = e as unknown as Record<string, unknown>;
  const startTime =
    typeof e.startTime === "number"
      ? e.startTime
      : typeof raw["startTimestamp"] === "number"
        ? (raw["startTimestamp"] as number)
        : 0;

  const rawEndTime = raw["endTime"];
  const endTime =
    rawEndTime instanceof Date
      ? rawEndTime.getTime()
      : typeof rawEndTime === "number"
        ? rawEndTime
        : null;

  const isPaused = breaks.some((b) => b.endTime === null);
  const now = Date.now();
  const workSeconds = computeWorkSeconds({ startTime, endTime }, breaks, now);
  const deductedBreakSeconds = computeDeductedBreakSeconds(breaks, now);
  const totalBreakSeconds = computeTotalBreakSeconds(breaks, now);

  // Strip internal DB fields (_id, clockEventId) from the public breaks shape
  const publicBreaks: ClockBreakInterval[] = breaks.map((b) => ({
    startTime: b.startTime,
    endTime: b.endTime,
    type: b.type,
    classificationSource: b.classificationSource,
    notes: b.notes,
    updatedBy: b.updatedBy,
    updatedAt: b.updatedAt,
  }));

  return {
    id: e._id.toHexString(),
    userId: e.userId,
    startTime,
    accumulatedTime: e.accumulatedTime,
    breaks: publicBreaks,
    workSeconds,
    deductedBreakSeconds,
    totalBreakSeconds,
    isPaused,
    endTime,
  };
}

export type PublicClockEvent = ReturnType<typeof toPublicClockEvent>;

// ─── ClockService ─────────────────────────────────────────────────────────────

export class ClockService {
  /** Return the active clock event across any team for the user. */
  async getActiveForUser(userId: string): Promise<ClockEvent | null> {
    return findActiveClockEventByUser(userId);
  }

  /** All clock events for a user (for their own timesheet & history). */
  async getForUser(userId: string): Promise<ClockEvent[]> {
    return findClockEventsForUser(userId);
  }

  async start(userId: string): Promise<PublicClockEvent> {
    const coll = clockEventsCollection();

    // Close any open events for this user
    const now = Date.now();
    await coll.updateMany({ userId, endTime: null }, { $set: { endTime: now } });

    const result = await coll.insertOne({
      _id: new ObjectId(),
      userId,
      startTime: now,
      accumulatedTime: 0,
      notifiedAt4h: null,
      endTime: null,
    });

    const created = await coll.findOne({ _id: result.insertedId });
    if (!created) throw new Error("Failed to create clock event");
    const pub = toPublicClockEvent(created, []);
    broadcast(userId, pub);

    return pub;
  }

  async stop(userId: string): Promise<PublicClockEvent | "not-found"> {
    const coll = clockEventsCollection();
    const event = await coll.findOne({ userId, endTime: null });
    if (!event) return "not-found";

    const now = Date.now();
    const eventId = event._id.toHexString();

    // Close any open timer sessions for this user
    await timerService.closeAllForUser(userId, now);

    // Close any open break with auto-classification
    const breaks = await findBreaksForEvent(eventId);
    const openBreak = breaks.find((b) => b.endTime === null);
    if (openBreak) {
      const durationSeconds = Math.floor((now - openBreak.startTime) / 1000);
      await clockBreaksCollection().updateOne(
        { _id: openBreak._id },
        { $set: { endTime: now, ...classifyBreak(durationSeconds) } }
      );
    }

    // Reload breaks with the open break now closed
    const closedBreaks = await findBreaksForEvent(eventId);

    // Compute final accumulated time: full shift span minus deducted (meal) breaks
    const shiftSpan = Math.floor((now - event.startTime) / 1000);
    const deducted = computeDeductedBreakSeconds(closedBreaks, now);
    const finalAccumulatedTime = Math.max(0, shiftSpan - deducted);

    await coll.updateOne(
      { _id: event._id },
      { $set: { endTime: now, accumulatedTime: finalAccumulatedTime } }
    );

    const updated = await coll.findOne({ _id: event._id });
    if (!updated) return "not-found";
    const pub = toPublicClockEvent(updated, closedBreaks);
    broadcast(userId, null); // null = user is no longer clocked in

    return pub;
  }

  async pause(userId: string): Promise<PublicClockEvent | "not-found" | "already-paused"> {
    const coll = clockEventsCollection();
    const event = await coll.findOne({ userId, endTime: null });
    if (!event) return "not-found";

    const breaks = await findBreaksForEvent(event._id.toHexString());
    if (breaks.some((b) => b.endTime === null)) return "already-paused";

    const now = Date.now();

    // Close any running timer session (not resumed automatically on resume)
    await timerService.closeRunningForUser(userId, now);

    await clockBreaksCollection().insertOne({
      _id: new ObjectId(),
      clockEventId: event._id.toHexString(),
      startTime: now,
      endTime: null,
    });

    // Use optimistic in-memory view — avoid extra round-trip
    const updatedBreaks: ClockBreakInterval[] = [...breaks, { startTime: now, endTime: null }];
    const pub = toPublicClockEvent(event, updatedBreaks);
    broadcast(userId, pub);
    return pub;
  }

  async resume(userId: string): Promise<PublicClockEvent | "not-found" | "not-paused"> {
    const coll = clockEventsCollection();
    const event = await coll.findOne({ userId, endTime: null });
    if (!event) return "not-found";

    const breaks = await findBreaksForEvent(event._id.toHexString());
    const openBreak = breaks.find((b) => b.endTime === null);
    if (!openBreak) return "not-paused";

    const now = Date.now();
    const durationSeconds = Math.floor((now - openBreak.startTime) / 1000);
    const classification = classifyBreak(durationSeconds);

    await clockBreaksCollection().updateOne(
      { _id: openBreak._id },
      { $set: { endTime: now, ...classification } }
    );

    const updatedBreaks: ClockBreakInterval[] = breaks.map((b) =>
      b._id.equals(openBreak._id) ? { ...b, endTime: now, ...classification } : b
    );
    const pub = toPublicClockEvent(event, updatedBreaks);
    broadcast(userId, pub);
    return pub;
  }

  async getStatus(userId: string): Promise<
    | {
        event: PublicClockEvent;
        workSeconds: number;
        isPaused: boolean;
      }
    | "not-found"
  > {
    const event = await this.getActiveForUser(userId);
    if (!event) return "not-found";

    const now = Date.now();
    const breaks = await findBreaksForEvent(event._id.toHexString());
    const workSeconds = computeWorkSeconds(event, breaks, now);
    return {
      event: toPublicClockEvent(event, breaks),
      workSeconds,
      isPaused: breaks.some((b) => b.endTime === null),
    };
  }

  async updateTimes(
    requesterId: string,
    clockEventId: string,
    data: {
      startTime?: number;
      endTime?: number | null;
      breaks?: Array<{
        startTime: number;
        endTime: number | null;
        type?: "rest" | "meal";
        classificationSource?: "auto" | "manual";
        notes?: string;
      }>;
    }
  ): Promise<PublicClockEvent | "not-found" | "forbidden" | "invalid-range"> {
    if (!isValidId(clockEventId)) return "not-found";
    const coll = clockEventsCollection();
    const event = await coll.findOne({ _id: new ObjectId(clockEventId) });
    if (!event) return "not-found";

    if (event.userId !== requesterId) {
      const sharedAdminTeam = await teamsCollection().findOne({
        admins: requesterId,
        $or: [{ members: event.userId }, { admins: event.userId }],
      });
      if (!sharedAdminTeam) return "forbidden";
    }

    const effectiveStart = typeof data.startTime === "number" ? data.startTime : event.startTime;
    const effectiveEnd =
      data.endTime === null
        ? null
        : typeof data.endTime === "number"
          ? data.endTime
          : event.endTime;
    if (effectiveEnd !== null && effectiveEnd < effectiveStart) {
      return "invalid-range";
    }

    const existingBreaks = await findBreaksForEvent(clockEventId);
    const requestedBreaks: ClockBreakInterval[] = Array.isArray(data.breaks)
      ? toBreakEntries(data.breaks)
      : existingBreaks;
    const normalizedBreaks = normalizeBreakEntries(requestedBreaks, effectiveStart, effectiveEnd);

    // Auto-classify any closed breaks that lack a type
    const now = Date.now();
    const classifiedBreaks: ClockBreakInterval[] = normalizedBreaks.map((b) => {
      if (b.endTime === null || b.type !== undefined) return b;
      const durationSeconds = Math.floor((b.endTime - b.startTime) / 1000);
      return { ...b, ...classifyBreak(durationSeconds) };
    });

    // Replace all breaks: delete existing + insert new
    await clockBreaksCollection().deleteMany({ clockEventId });
    if (classifiedBreaks.length) {
      await clockBreaksCollection().insertMany(
        classifiedBreaks.map((b) => ({
          _id: new ObjectId(),
          clockEventId,
          ...b,
        }))
      );
    }

    // Update the clock event itself
    const $set: Record<string, unknown> = {};
    if (typeof data.startTime === "number") $set.startTime = data.startTime;
    if (data.endTime === null) $set.endTime = null;
    else if (typeof data.endTime === "number") $set.endTime = data.endTime;

    if (effectiveEnd !== null) {
      const deductedSeconds = computeDeductedBreakSeconds(classifiedBreaks, now);
      const spanSeconds = Math.max(0, Math.floor((effectiveEnd - effectiveStart) / 1000));
      $set.accumulatedTime = Math.max(0, spanSeconds - deductedSeconds);
    }

    if (Object.keys($set).length > 0) await coll.updateOne({ _id: event._id }, { $set });

    const updated = await coll.findOne({ _id: event._id });
    const updatedBreaks = await findBreaksForEvent(clockEventId);
    return updated ? toPublicClockEvent(updated, updatedBreaks) : "not-found";
  }

  async deleteEvent(
    requesterId: string,
    clockEventId: string
  ): Promise<"ok" | "not-found" | "forbidden"> {
    if (!isValidId(clockEventId)) return "not-found";

    const coll = clockEventsCollection();
    const event = await coll.findOne({ _id: new ObjectId(clockEventId) });
    if (!event) return "not-found";

    if (event.userId !== requesterId) {
      const sharedAdminTeam = await teamsCollection().findOne({
        admins: requesterId,
        $or: [{ members: event.userId }, { admins: event.userId }],
      });
      if (!sharedAdminTeam) return "forbidden";
    }

    await coll.deleteOne({ _id: event._id });
    // Delete all breaks for this event
    await clockBreaksCollection().deleteMany({ clockEventId });
    await attachmentsCollection().deleteMany({
      "attachedTo.kind": "clock",
      "attachedTo.id": clockEventId,
    });

    if (event.endTime === null) broadcast(event.userId, null);

    return "ok";
  }

  /**
   * Create a completed clock event for a past time range (manual backfill).
   * Both times must be in the past.
   */
  async createManual(
    userId: string,
    startTime: number,
    endTime: number
  ): Promise<PublicClockEvent | "invalid-range"> {
    const now = Date.now();
    if (startTime > now || endTime > now) return "invalid-range";
    if (endTime <= startTime) return "invalid-range";

    const accumulatedTime = Math.floor((endTime - startTime) / 1000);
    const coll = clockEventsCollection();
    const result = await coll.insertOne({
      _id: new ObjectId(),
      userId,
      startTime,
      accumulatedTime,
      endTime,
    });

    const created = await coll.findOne({ _id: result.insertedId });
    if (!created) throw new Error("Failed to create manual clock event");
    return toPublicClockEvent(created, []);
  }

  async getTimesheet(
    requesterId: string,
    targetUserId: string,
    startMs: number,
    endMs: number
  ): Promise<
    | {
        sessions: ReturnType<typeof toPublicClockEvent>[];
        summary: {
          totalSeconds: number;
          totalBreakSeconds: number;
          totalSessions: number;
          completedSessions: number;
          averageSessionSeconds: number;
          workingDays: number;
        };
      }
    | "forbidden"
  > {
    if (requesterId !== targetUserId) {
      const sharedAdminTeam = await teamsCollection().findOne({
        admins: requesterId,
        $or: [{ members: targetUserId }, { admins: targetUserId }],
      });
      if (!sharedAdminTeam) return "forbidden";
    }

    const events = await clockEventsCollection()
      .find({
        userId: targetUserId,
        startTime: { $gte: startMs, $lte: endMs },
      })
      .sort({ startTime: -1 })
      .toArray();

    // Batch-load all breaks in one query
    const eventIds = events.map((e) => e._id.toHexString());
    const allBreaks = await findBreaksForEvents(eventIds);
    const breaksByEventId = new Map<string, ClockBreak[]>();
    for (const b of allBreaks) {
      const arr = breaksByEventId.get(b.clockEventId) ?? [];
      arr.push(b);
      breaksByEventId.set(b.clockEventId, arr);
    }

    const now = Date.now();
    const sessions = events
      .map((e) => toPublicClockEvent(e, breaksByEventId.get(e._id.toHexString()) ?? []))
      .sort((a, b) => b.startTime - a.startTime);

    const completed = sessions.filter((s) => s.endTime !== null);
    const totalSeconds = sessions.reduce((sum, s) => {
      if (!s.endTime) {
        const breaks = breaksByEventId.get(s.id) ?? [];
        return sum + computeWorkSeconds(s, breaks, now);
      }
      const accumulated = s.accumulatedTime ?? 0;
      if (accumulated > 0) return sum + accumulated;
      return sum + Math.max(0, Math.floor((s.endTime - s.startTime) / 1000));
    }, 0);
    const avgSeconds = completed.length > 0 ? totalSeconds / completed.length : 0;
    const totalBreakSeconds = sessions.reduce((sum, s) => {
      return sum + computeTotalBreakSeconds(s.breaks, now);
    }, 0);
    const uniqueDates = new Set(
      sessions.map((s) => new Date(s.startTime).toISOString().split("T")[0])
    );

    return {
      sessions,
      summary: {
        totalSeconds,
        totalBreakSeconds,
        totalSessions: sessions.length,
        completedSessions: completed.length,
        averageSessionSeconds: avgSeconds,
        workingDays: uniqueDates.size,
      },
    };
  }
}

export const clockService = new ClockService();
