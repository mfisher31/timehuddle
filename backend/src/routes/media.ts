import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/require-auth.js";
import { teamsCollection } from "../models/index.js";
import { mediaService } from "../services/media.service.js";
import { getVideoStorageDir } from "../lib/video-storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const thumbnailsDir = path.resolve(__dirname, "../../uploads/thumbnails");
const mediaDir = path.resolve(__dirname, "../../uploads/media");
const videosDir = getVideoStorageDir();

function buildImageFilename(userId: string, ext: string): string {
  const hex = randomBytes(8).toString("hex");
  return `${userId}-${hex}.${ext}`;
}

function buildThumbnailFilename(userId: string): string {
  const hex = randomBytes(8).toString("hex");
  return `${userId}-${hex}.jpg`;
}

function imageExtFromMime(mimeType: string): string | null {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

function isAllowedThumbnailMimeType(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp";
}

function resolveUploadPath(
  url: string | null,
  expectedPrefix: string,
  baseDir: string
): string | null {
  if (!url || !url.startsWith(expectedPrefix)) return null;
  const rawName = url.slice(expectedPrefix.length);
  const safeName = path.basename(rawName);
  if (!safeName) return null;
  return path.join(baseDir, safeName);
}

async function cleanupMediaFiles(item: {
  url: string;
  thumbnail: string | null;
  videoid: string | null;
}): Promise<void> {
  const cleanupTargets: string[] = [];

  const imagePath = resolveUploadPath(item.url, "/uploads/media/", mediaDir);
  if (imagePath) cleanupTargets.push(imagePath);

  const thumbnailPath = resolveUploadPath(item.thumbnail, "/uploads/thumbnails/", thumbnailsDir);
  if (thumbnailPath) cleanupTargets.push(thumbnailPath);

  await Promise.all(
    cleanupTargets.map(async (targetPath) => {
      try {
        await fs.unlink(targetPath);
      } catch {
        // Best-effort cleanup: database delete already succeeded.
      }
    })
  );

  if (item.videoid) {
    try {
      await fs.rm(path.join(videosDir, item.videoid), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: database delete already succeeded.
    }
  }
}

const mediaItemShape = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    type: { type: "string" },
    mimeType: { type: "string" },
    url: { type: "string" },
    videoid: { type: "string", nullable: true },
    filename: { type: "string" },
    size: { type: "number" },
    title: { type: "string", nullable: true },
    caption: { type: "string", nullable: true },
    altText: { type: "string", nullable: true },
    thumbnail: { type: "string", nullable: true },
    uploadedAt: { type: "string" },
  },
};

export async function mediaRoutes(app: FastifyInstance) {
  // POST /v1/media — upload an image to the media library
  app.post(
    "/media",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "Upload an image to the media library",
        response: {
          200: { type: "object", properties: { item: mediaItemShape } },
          400: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const userId = req.user!.id;
      const data = await req.file();
      if (!data) return reply.status(400).send({ error: "No file uploaded" });

      const ext = imageExtFromMime(data.mimetype);
      if (!ext) {
        return reply.status(400).send({ error: "Unsupported image type" });
      }

      const buffer = await data.toBuffer();
      if (buffer.length === 0) {
        return reply.status(400).send({ error: "Empty file" });
      }

      await fs.mkdir(mediaDir, { recursive: true });
      const filename = buildImageFilename(userId, ext);
      const dest = path.join(mediaDir, filename);
      await fs.writeFile(dest, buffer);

      const url = `/uploads/media/${filename}`;
      const item = await mediaService.create(userId, {
        type: "image",
        mimeType: data.mimetype,
        url,
        filename,
        size: buffer.length,
        title: data.filename || undefined,
      });

      return reply.send({ item });
    }
  );

  // GET /v1/media - List media for authorized user
  app.get(
    "/media",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "List media library items for a user",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", default: 50 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: { type: "array", items: mediaItemShape },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { limit } = req.query as { limit?: number };
      const userId = req.user!.id;
      const items = await mediaService.getForUser(userId, limit ?? 50);
      return reply.send({ items });
    }
  );

  // GET /v1/media/user/:userId — list media items for a specific profile user
  app.get(
    "/media/user/:userId",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "List media library items for a specific user profile",
        params: {
          type: "object",
          required: ["userId"],
          properties: {
            userId: { type: "string", pattern: "^[0-9a-f]{24}$" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", default: 50 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: { type: "array", items: mediaItemShape },
            },
          },
          403: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const { limit } = req.query as { limit?: number };
      const viewerId = req.user!.id;

      if (viewerId !== userId) {
        const sharedTeam = await teamsCollection().findOne({
          members: { $all: [viewerId, userId] },
          isPersonal: { $ne: true },
        });

        if (!sharedTeam) {
          return reply.status(403).send({ error: "Forbidden" });
        }
      }

      const items = await mediaService.getForUser(userId, limit ?? 50);
      return reply.send({ items });
    }
  );

  // DELETE /v1/media/:id — remove a media item (owner only)
  app.delete(
    "/media/:id",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "Delete a media library item",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;
      const result = await mediaService.remove(userId, id);
      if (result.status === "not-found") return reply.status(404).send({ error: "Not found" });
      if (result.status === "forbidden") return reply.status(403).send({ error: "Forbidden" });
      await cleanupMediaFiles(result.item);
      return reply.send({ ok: true });
    }
  );

  // PATCH /v1/media/:id — update editable metadata (owner only)
  app.patch(
    "/media/:id",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "Update media item metadata",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string" },
            caption: { type: "string" },
            altText: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { item: mediaItemShape } },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;
      const body = req.body as { title?: string; caption?: string; altText?: string };
      const result = await mediaService.update(userId, id, body);
      if (result === "not-found") return reply.status(404).send({ error: "Not found" });
      if (result === "forbidden") return reply.status(403).send({ error: "Forbidden" });
      return reply.send({ item: result });
    }
  );

  // POST /v1/media/:id/thumbnail — upload a JPEG thumbnail (owner only, multipart)
  app.post(
    "/media/:id/thumbnail",
    {
      onRequest: [requireAuth],
      schema: {
        tags: ["Media"],
        summary: "Upload a thumbnail image for a media item",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: { type: "object", properties: { item: mediaItemShape } },
          400: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;

      const ownership = await mediaService.ensureOwned(userId, id);
      if (ownership === "not-found") return reply.status(404).send({ error: "Not found" });
      if (ownership === "forbidden") return reply.status(403).send({ error: "Forbidden" });

      const existing = await mediaService.findById(id);
      const previousThumbnailUrl = existing?.thumbnail ?? null;

      const data = await req.file();
      if (!data) return reply.status(400).send({ error: "No file uploaded" });

      if (!isAllowedThumbnailMimeType(data.mimetype)) {
        return reply.status(400).send({ error: "Unsupported thumbnail type" });
      }

      const thumbnailBuffer = await data.toBuffer();
      if (thumbnailBuffer.length === 0) {
        return reply.status(400).send({ error: "Empty file" });
      }

      await fs.mkdir(thumbnailsDir, { recursive: true });
      const filename = buildThumbnailFilename(userId);
      const dest = path.join(thumbnailsDir, filename);
      await fs.writeFile(dest, thumbnailBuffer);

      const thumbnailUrl = `/uploads/thumbnails/${filename}`;

      const result = await mediaService.setThumbnail(userId, id, thumbnailUrl);
      if (result === "not-found") return reply.status(404).send({ error: "Not found" });
      if (result === "forbidden") return reply.status(403).send({ error: "Forbidden" });

      const previousThumbnailPath = resolveUploadPath(
        previousThumbnailUrl,
        "/uploads/thumbnails/",
        thumbnailsDir
      );
      const nextThumbnailPath = resolveUploadPath(
        result.thumbnail,
        "/uploads/thumbnails/",
        thumbnailsDir
      );
      if (previousThumbnailPath && previousThumbnailPath !== nextThumbnailPath) {
        try {
          await fs.unlink(previousThumbnailPath);
        } catch {
          // Best-effort cleanup: thumbnail metadata update already succeeded.
        }
      }

      return reply.send({ item: result });
    }
  );
}
