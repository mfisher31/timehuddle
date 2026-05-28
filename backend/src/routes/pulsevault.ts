import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
  buildUploadLink,
} from "@mieweb/pulsevault";
import { fromNodeHeaders } from "better-auth/node";
import { requireAuth } from "../middleware/require-auth.js";
import { auth } from "../lib/auth.js";
import { getVideoStorageDir } from "../lib/video-storage.js";
import { mediaItemsCollection, teamsCollection } from "../models/index.js";
import { ticketService } from "../services/ticket.service.js";
import { attachmentService } from "../services/attachment.service.js";
import { mediaService } from "../services/media.service.js";
import {
  reserveVideo,
  reserveVideoForLibrary,
  getReservation,
  verifyReservationToken,
  consumeReservation,
} from "../services/video-reserve.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = getVideoStorageDir();

type ReserveTarget = "ticket" | "library";
type ReserveRequestBody = {
  target?: ReserveTarget;
  ticketId?: string;
  videoid?: string;
};

function extractBearerToken(request: any): string | undefined {
  const authHeader = request.headers?.authorization;
  if (typeof authHeader !== "string") return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function pulseVaultHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function resolveUploadedFilename(ctx: any): Promise<string> {
  const metadataFilename =
    ctx?.metadata?.filename ?? ctx?.meta?.filename ?? ctx?.upload?.metadata?.filename;

  if (typeof metadataFilename === "string" && metadataFilename.trim()) {
    return path.basename(metadataFilename.trim());
  }

  // Local Pulsevault storage writes original upload metadata to a sidecar.
  try {
    const sidecarPath = path.join(dataDir, ctx.videoid, ".pulsevault.json");
    const raw = await fs.readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw) as { filename?: unknown };
    if (typeof parsed.filename === "string" && parsed.filename.trim()) {
      return path.basename(parsed.filename.trim());
    }
  } catch {
    // Ignore and fall back below.
  }

  return `${ctx.videoid}.mp4`;
}

function resolveUploadedTitle(filename: string, fallbackVideoid: string): string {
  const parsed = path.parse(filename).name.trim();
  const normalized = parsed.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || `Video ${fallbackVideoid.slice(0, 8)}`;
}

// Shared storage instance — used by both the versioned and compat registrations.
const storage = createLocalStorage({ workspaceDir: dataDir });

async function authorizeHandler(request: any, ctx: any) {
  if (ctx.phase !== "resolve") {
    const bearerToken = extractBearerToken(request);
    if (bearerToken && verifyReservationToken(ctx.videoid, bearerToken)) {
      return;
    }
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers as Record<string, string | string[]>),
  });
  if (!session) {
    throw pulseVaultHttpError(401, "Unauthorized");
  }

  if (ctx.phase === "resolve") {
    // Tighten playback visibility for media library videos to match
    // /v1/media/user/:userId shared-team gating.
    const mediaItem = await mediaItemsCollection().findOne({ videoid: ctx.videoid });
    if (mediaItem) {
      if (mediaItem.userId === session.user.id) return;
      const sharedTeam = await teamsCollection().findOne({
        members: { $all: [session.user.id, mediaItem.userId] },
        isPersonal: { $ne: true },
      });
      if (!sharedTeam) {
        throw pulseVaultHttpError(403, "Forbidden");
      }
    }
    // Non-media resolve paths still require auth; deeper per-entity auth can be
    // tightened in a follow-up without reopening public read access.
    return;
  }

  const reservation = getReservation(ctx.videoid);
  if (!reservation) {
    throw pulseVaultHttpError(403, "Video reservation required");
  }
  if (reservation.userId !== session.user.id) {
    throw pulseVaultHttpError(403, "Forbidden");
  }
}

async function onUploadCompleteHandler(request: any, ctx: any) {
  const reservation = consumeReservation(ctx.videoid);
  if (!reservation) return;

  const filename = await resolveUploadedFilename(ctx);
  const title = resolveUploadedTitle(filename, ctx.videoid);

  const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host =
    (request.headers["x-forwarded-host"] as string | undefined) ??
    (request.headers["host"] as string | undefined) ??
    "localhost:4000";
  const videoUrl = `${proto}://${host}/v1/video/${ctx.videoid}`;

  if (reservation.context.kind === "library") {
    await mediaService.create(reservation.userId, {
      type: "video",
      mimeType: "video/mp4",
      url: videoUrl,
      videoid: ctx.videoid,
      filename,
      size: ctx.size ?? 0,
      title,
    });
  } else {
    await attachmentService.create(
      reservation.userId,
      videoUrl,
      "video",
      { kind: "ticket", id: reservation.context.ticketId },
      { title }
    );
  }
}

async function createReserveResponse(
  req: any,
  userId: string,
  body: ReserveRequestBody
): Promise<{ videoid: string; uploadToken: string; uploadLink?: string }> {
  const target: ReserveTarget = body.target ?? "ticket";

  if (target === "library") {
    const videoid = randomUUID();
    const uploadToken = reserveVideoForLibrary(videoid, userId);
    return { videoid, uploadToken };
  }

  if (!body.ticketId) {
    throw pulseVaultHttpError(400, "ticketId is required for ticket uploads");
  }

  const ticket = await ticketService.findById(body.ticketId);
  if (!ticket) {
    throw pulseVaultHttpError(404, "Ticket not found");
  }

  let videoid = body.videoid ?? randomUUID();

  if (body.videoid) {
    const alreadyReady = await storage.resolve(body.videoid);
    if (alreadyReady) {
      videoid = randomUUID();
    } else {
      await storage.remove?.(body.videoid);
    }
  }

  const uploadToken = reserveVideo(videoid, body.ticketId, userId);

  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers["host"] as string | undefined) ??
    "localhost:4000";
  const uploadLink = buildUploadLink({ server: `${proto}://${host}`, videoid });

  return { videoid, uploadToken, uploadLink };
}

// Compat: old Pulse Cam configs that saved the bare server URL (http://host:4000) call
// POST /reserve, POST /upload, PATCH /upload/:id etc. at root level.
// Pulse Cam has no session — uploads at the compat path are unauthenticated.

async function openAuthorizeHandler(_request: any, ctx: any) {
  if (ctx.phase === "resolve") return; // playback always open
  // Allow unauthenticated uploads from Pulse Cam on the compat (root) path.
}

export async function pulseVaultCompatRoutes(app: FastifyInstance) {
  // /reserve at root — Pulse Cam calls this before each upload
  app.post("/reserve", async (_req, reply) => {
    return reply.status(200).send({ videoid: randomUUID() });
  });

  await app.register(pulseVault, {
    prefix: "",
    storage,
    maxUploadSize: 1 * 1024 * 1024 * 1024,
    allowedExtensions: [".mp4"],
    validatePayload: createMp4Sniffer(storage),
    authorize: openAuthorizeHandler,
    onUploadComplete: onUploadCompleteHandler,
    decoratorName: "pulseVaultCompat",
  });
}

export async function pulseVaultRoutes(app: FastifyInstance) {
  // POST /v1/video/reserve — authenticated reserve endpoint for all app uploads.
  // target=ticket (default): requires ticketId and supports optional videoid for resume.
  // target=library: reserves a media-library upload id.
  app.post(
    "/video/reserve",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Attachments"],
        summary: "Reserve a videoid for ticket or media-library TUS uploads",
        body: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["ticket", "library"] },
            ticketId: { type: "string", pattern: "^[0-9a-f]{24}$" },
            videoid: {
              type: "string",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              videoid: { type: "string" },
              uploadToken: { type: "string" },
              uploadLink: {
                type: "string",
                description: "pulsecam:// deep link for ticket upload pairing",
              },
            },
          },
          400: {
            type: "object",
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const reserved = await createReserveResponse(
        req,
        req.user!.id,
        (req.body ?? {}) as ReserveRequestBody
      );
      return reply.status(201).send(reserved);
    }
  );

  await app.register(pulseVault, {
    prefix: "/video",
    storage,
    maxUploadSize: 1 * 1024 * 1024 * 1024, // 1 GiB
    allowedExtensions: [".mp4"],
    validatePayload: createMp4Sniffer(storage),
    authorize: authorizeHandler,
    onUploadComplete: onUploadCompleteHandler,
    decoratorName: "pulseVaultV1",
  });
}
