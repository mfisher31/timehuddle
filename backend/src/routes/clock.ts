import { FastifyInstance } from "fastify";
import { auth } from "../lib/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { clockService, toPublicClockEvent, subscribe } from "../services/clock.service.js";
import { findBreaksForEvents } from "../models/clock.model.js";
import { clockController } from "../controllers/clock.controller.js";

// ─── Public shape schema ──────────────────────────────────────────────────────

const clockEventShape = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    startTime: { type: "number" },
    accumulatedTime: { type: "number" },
    breaks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startTime: { type: "number" },
          endTime: { type: "number", nullable: true },
          type: { type: "string", enum: ["rest", "meal"] },
          classificationSource: { type: "string", enum: ["auto", "manual"] },
          notes: { type: "string" },
        },
      },
    },
    workSeconds: { type: "number" },
    deductedBreakSeconds: { type: "number" },
    totalBreakSeconds: { type: "number" },
    isPaused: { type: "boolean" },
    endTime: { type: "number", nullable: true },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function clockRoutes(app: FastifyInstance) {
  // POST /v1/clock/start
  app.post(
    "/clock/start",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        response: { 200: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.start
  );

  // POST /v1/clock/stop
  app.post(
    "/clock/stop",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        response: { 200: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.stop
  );

  // POST /v1/clock/pause
  app.post(
    "/clock/pause",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        response: { 200: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.pause
  );

  // POST /v1/clock/resume
  app.post(
    "/clock/resume",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        response: { 200: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.resume
  );

  // GET /v1/clock/status
  app.get(
    "/clock/status",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
      },
    },
    clockController.getStatus
  );

  // PUT /v1/clock/:id/times
  app.put(
    "/clock/:id/times",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            startTime: { type: "number" },
            endTime: { type: "number", nullable: true },
            breaks: {
              type: "array",
              items: {
                type: "object",
                required: ["startTime"],
                properties: {
                  startTime: { type: "number" },
                  endTime: { type: "number", nullable: true },
                  type: { type: "string", enum: ["rest", "meal"] },
                  classificationSource: { type: "string", enum: ["auto", "manual"] },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        response: { 200: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.updateTimes
  );

  // DELETE /v1/clock/:id
  app.delete(
    "/clock/:id",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } },
      },
    },
    clockController.deleteEvent
  );

  // POST /v1/clock/manual — create a completed past clock entry
  app.post(
    "/clock/manual",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        body: {
          type: "object",
          required: ["startTime", "endTime"],
          properties: {
            startTime: { type: "number" },
            endTime: { type: "number" },
          },
        },
        response: { 201: { type: "object", properties: { event: clockEventShape } } },
      },
    },
    clockController.createManual
  );

  // GET /v1/clock/timesheet
  app.get(
    "/clock/timesheet",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        querystring: {
          type: "object",
          required: ["userId", "startMs", "endMs"],
          properties: {
            userId: { type: "string" },
            startMs: { type: "number" },
            endMs: { type: "number" },
          },
        },
      },
    },
    clockController.getTimesheet
  );

  // GET /v1/clock/active — current user's active event (any team)
  app.get(
    "/clock/active",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Clock"],
        response: {
          200: {
            type: "object",
            properties: { event: { ...clockEventShape, nullable: true } },
          },
        },
      },
    },
    clockController.getActive
  );

  // GET /v1/clock/events — all events for current user
  app.get(
    "/clock/events",
    {
      onRequest: [requireAuth],
      schema: { tags: ["Clock"] },
    },
    clockController.getEvents
  );

  // GET /v1/clock/ws — WebSocket stream for current user's live clock state
  app.get("/clock/ws", { websocket: true }, async (socket, req) => {
    const { token: queryToken } = req.query as {
      token?: string;
    };

    // Auth: accept Bearer token from query param (Capacitor) or cookie
    const headers: Record<string, string> = { ...(req.headers as any) };
    if (queryToken) headers["authorization"] = `Bearer ${queryToken}`;
    const session = await auth.api.getSession({ headers });
    if (!session?.user) {
      socket.close(4001, "Unauthorized");
      return;
    }

    const userId = session.user.id;

    // Send initial snapshot
    const active = await clockService.getActiveForUser(userId);
    const initialIds = active ? [active._id.toHexString()] : [];
    const initialBreaks = await findBreaksForEvents(initialIds);
    const snapshot = active ? [toPublicClockEvent(active, initialBreaks)] : [];
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "snapshot", events: snapshot }));
    }

    // Subscribe to future broadcasts
    const unsub = subscribe((changedUserId, event) => {
      if (changedUserId !== userId) return;
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "update", event }));
      }
    });

    socket.on("close", unsub);
  });
}
