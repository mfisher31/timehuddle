import { clockEventsCollection } from "../models/index.js";
import type { ClockEvent } from "../models/clock.model.js";
import { findBreaksForEvents } from "../models/clock.model.js";
import { computeWorkSeconds } from "./clock.service.js";
import { notificationService } from "./notification.service.js";

const FOUR_HOURS_SECONDS = 4 * 60 * 60;

class ClockMonitorService {
  async checkAndEnforce(now = Date.now()): Promise<{
    reminded4h: number;
  }> {
    const coll = clockEventsCollection();
    const activeEvents = await coll
      .find({
        endTime: null,
      })
      .toArray();

    let reminded4h = 0;

    const activeIds = activeEvents.map((e) => e._id.toHexString());
    const allBreaks = await findBreaksForEvents(activeIds);
    const breaksByEventId = new Map<string, typeof allBreaks>();
    for (const b of allBreaks) {
      const arr = breaksByEventId.get(b.clockEventId) ?? [];
      arr.push(b);
      breaksByEventId.set(b.clockEventId, arr);
    }

    for (const event of activeEvents) {
      const breaks = breaksByEventId.get(event._id.toHexString()) ?? [];
      const workSeconds = computeWorkSeconds(event as ClockEvent, breaks, now);

      if (workSeconds >= FOUR_HOURS_SECONDS && event.notifiedAt4h == null) {
        const locked = await coll.updateOne(
          { _id: event._id, endTime: null, notifiedAt4h: null },
          { $set: { notifiedAt4h: now } }
        );
        if (locked.modifiedCount === 1) {
          reminded4h += 1;
          await notificationService.create({
            userId: event.userId,
            title: "TiméHuddle",
            body: "Take a break. You have worked for 4 hours.",
            notificationData: {
              type: "break-reminder-4h",
              clockEventId: event._id.toHexString(),
              url: "/app/clock",
            },
          });
        }
      }
    }

    return { reminded4h };
  }
}

export const clockMonitorService = new ClockMonitorService();

let clockMonitorInterval: NodeJS.Timeout | null = null;

export function startClockMonitor(intervalMs = 30_000): void {
  if (clockMonitorInterval) return;
  clockMonitorInterval = setInterval(() => {
    void clockMonitorService.checkAndEnforce().catch((err) => {
      console.error("[clock-monitor] failed:", err);
    });
  }, intervalMs);
}

export function stopClockMonitor(): void {
  if (!clockMonitorInterval) return;
  clearInterval(clockMonitorInterval);
  clockMonitorInterval = null;
}
