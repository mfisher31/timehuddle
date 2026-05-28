import type { FastifyReply, FastifyRequest } from "fastify";
import { clockService, toPublicClockEvent } from "../services/clock.service.js";
import { findBreaksForEvent, findBreaksForEvents } from "../models/clock.model.js";
import type { ClockBreak } from "../models/clock.model.js";

export const clockController = {
  async start(req: FastifyRequest) {
    const userId = req.user!.id;
    const result = await clockService.start(userId);
    return { event: result };
  },

  async stop(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const result = await clockService.stop(userId);
    if (result === "not-found") return reply.status(404).send({ error: "No active clock event" });
    return { event: result };
  },

  async pause(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const result = await clockService.pause(userId);
    if (result === "not-found") return reply.status(404).send({ error: "No active clock event" });
    if (result === "already-paused")
      return reply.status(409).send({ error: "Clock is already paused" });
    return { event: result };
  },

  async resume(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const result = await clockService.resume(userId);
    if (result === "not-found") return reply.status(404).send({ error: "No active clock event" });
    if (result === "not-paused") return reply.status(409).send({ error: "Clock is not paused" });
    return { event: result };
  },

  async getStatus(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const result = await clockService.getStatus(userId);
    if (result === "not-found") return reply.status(404).send({ error: "No active clock event" });
    return result;
  },

  async updateTimes(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const { id: clockEventId } = req.params as { id: string };
    const data = req.body as {
      startTime?: number;
      endTime?: number | null;
      breaks?: Array<{ startTime: number; endTime: number | null }>;
    };
    const result = await clockService.updateTimes(userId, clockEventId, data);
    if (result === "not-found") return reply.status(404).send({ error: "Clock event not found" });
    if (result === "forbidden") return reply.status(403).send({ error: "Forbidden" });
    if (result === "invalid-range")
      return reply.status(422).send({ error: "Clock-out cannot be earlier than clock-in" });
    return { event: result };
  },

  async deleteEvent(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const { id: clockEventId } = req.params as { id: string };
    const result = await clockService.deleteEvent(userId, clockEventId);
    if (result === "not-found") return reply.status(404).send({ error: "Clock event not found" });
    if (result === "forbidden") return reply.status(403).send({ error: "Forbidden" });
    return { ok: true };
  },

  async createManual(req: FastifyRequest, reply: FastifyReply) {
    const userId = req.user!.id;
    const { startTime, endTime } = req.body as {
      startTime: number;
      endTime: number;
    };
    const result = await clockService.createManual(userId, startTime, endTime);
    if (result === "invalid-range")
      return reply
        .status(422)
        .send({ error: "Times must be in the past and clock-out must be after clock-in." });
    return reply.status(201).send({ event: result });
  },

  async getTimesheet(req: FastifyRequest, reply: FastifyReply) {
    const requesterId = req.user!.id;
    const { userId, startMs, endMs } = req.query as {
      userId: string;
      startMs: number;
      endMs: number;
    };
    const result = await clockService.getTimesheet(requesterId, userId, startMs, endMs);
    if (result === "forbidden") return reply.status(403).send({ error: "Forbidden" });
    return result;
  },

  async getActive(req: FastifyRequest) {
    const userId = req.user!.id;
    const event = await clockService.getActiveForUser(userId);
    const breaks = event ? await findBreaksForEvent(event._id.toHexString()) : [];
    return { event: event ? toPublicClockEvent(event, breaks) : null };
  },

  async getEvents(req: FastifyRequest) {
    const userId = req.user!.id;
    const events = await clockService.getForUser(userId);
    const eventIds = events.map((e) => e._id.toHexString());
    const allBreaks = await findBreaksForEvents(eventIds);
    const breaksByEventId = new Map<string, ClockBreak[]>();
    for (const b of allBreaks) {
      const arr = breaksByEventId.get(b.clockEventId) ?? [];
      arr.push(b);
      breaksByEventId.set(b.clockEventId, arr);
    }
    return {
      events: events.map((e) =>
        toPublicClockEvent(e, breaksByEventId.get(e._id.toHexString()) ?? [])
      ),
    };
  },
};
