import { ObjectId } from "mongodb";
import { clockEventsCollection, clockBreaksCollection } from "./index.js";

/**
 * Minimal break shape used for pay calculations and public API responses.
 * Both parsed API input and stored ClockBreak documents satisfy this interface.
 */
export interface ClockBreakInterval {
  startTime: number; // epoch ms
  endTime: number | null; // null = break in progress
  type?: "rest" | "meal"; // set when break closes
  classificationSource?: "auto" | "manual"; // "auto" = duration-based default
  notes?: string;
  updatedBy?: string; // userId of last editor
  updatedAt?: number; // epoch ms of last edit
}

/**
 * Full break document stored in the `clockbreaks` collection.
 * "rest" breaks (< 20 min) are compensable — not deducted from pay.
 * "meal" breaks (≥ 20 min) are non-compensable — deducted from accumulatedTime.
 */
export interface ClockBreak extends ClockBreakInterval {
  _id: ObjectId;
  clockEventId: string; // hex string of the parent ClockEvent._id
}

export interface ClockEvent {
  _id: ObjectId;
  userId: string;
  startTime: number; // epoch ms — shift start (mutable via updateTimes)
  accumulatedTime: number; // seconds — computed at clock-out (span minus deducted breaks)
  notifiedAt4h?: number | null; // epoch ms when 4h reminder was sent
  endTime: number | null; // epoch ms — null = still clocked in
}

// ─── ClockEvent helpers ────────────────────────────────────────────────────────

export async function findActiveClockEventByUser(userId: string): Promise<ClockEvent | null> {
  return clockEventsCollection().findOne({ userId, endTime: null });
}

export async function findClockEventsForUser(userId: string): Promise<ClockEvent[]> {
  return clockEventsCollection().find({ userId }).sort({ startTime: -1 }).toArray();
}

// ─── ClockBreak helpers ────────────────────────────────────────────────────────

/** Load all breaks for a single clock event, ordered by startTime. */
export async function findBreaksForEvent(clockEventId: string): Promise<ClockBreak[]> {
  return clockBreaksCollection().find({ clockEventId }).sort({ startTime: 1 }).toArray();
}

/** Batch-load breaks for multiple clock events in one query, ordered by startTime. */
export async function findBreaksForEvents(clockEventIds: string[]): Promise<ClockBreak[]> {
  if (!clockEventIds.length) return [];
  return clockBreaksCollection()
    .find({ clockEventId: { $in: clockEventIds } })
    .sort({ startTime: 1 })
    .toArray();
}
