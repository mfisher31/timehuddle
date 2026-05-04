/**
 * OAuth Application management routes.
 *
 * Allows authenticated users to register and manage OAuth 2.0 client
 * applications that can "Login with TimeHuddle" via PKCE.
 *
 * Routes:
 *   GET    /v1/oauth/applications         — list apps owned by the current user
 *   POST   /v1/oauth/applications         — register a new app
 *   DELETE /v1/oauth/applications/:id     — revoke / delete an app
 */

import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/require-auth.js";
import { auth } from "../lib/auth.js";
import { getDB } from "../lib/db.js";

interface OAuthApplicationDoc {
  id: string;
  clientId: string;
  clientSecret?: string;
  name: string;
  redirectUrls: string;  // comma-separated in better-auth's schema
  metadata?: string;
  type: string;
  disabled?: boolean;
  userId?: string;
  createdAt: Date;
  updatedAt: Date;
}

function oauthAppsCollection() {
  return getDB().collection<OAuthApplicationDoc>("oauthApplication");
}

function parseRedirectUrls(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function toResponse(doc: OAuthApplicationDoc) {
  let type = doc.type;
  try {
    const meta = doc.metadata ? JSON.parse(doc.metadata) : {};
    if (meta.type) type = meta.type;
  } catch { /* ignore */ }
  return {
    id: doc.id,
    clientId: doc.clientId,
    name: doc.name,
    redirectUrls: parseRedirectUrls(doc.redirectUrls),
    type,
    disabled: doc.disabled ?? false,
    createdAt: doc.createdAt,
  };
}

export async function oauthAppRoutes(app: FastifyInstance) {
  // ── GET /v1/oauth/applications ──────────────────────────────────────────────
  app.get(
    "/oauth/applications",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["OAuth"],
        summary: "List OAuth applications owned by the current user",
        security: [{ cookieAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              applications: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    clientId: { type: "string" },
                    name: { type: "string" },
                    redirectUrls: { type: "array", items: { type: "string" } },
                    type: { type: "string" },
                    disabled: { type: "boolean" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          401: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const docs = await oauthAppsCollection()
        .find({ userId: req.user!.id })
        .sort({ createdAt: -1 })
        .toArray();
      return reply.send({ applications: docs.map(toResponse) });
    }
  );

  // ── POST /v1/oauth/applications ─────────────────────────────────────────────
  app.post(
    "/oauth/applications",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["OAuth"],
        summary: "Register a new OAuth application",
        security: [{ cookieAuth: [] }],
        body: {
          type: "object",
          required: ["name", "redirectUris"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            redirectUris: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description:
                "Allowed redirect URIs (e.g. https://myapp.com/callback or myapp://callback)",
            },
            type: {
              type: "string",
              enum: ["web", "native", "spa"],
              default: "native",
              description:
                "web = server-side, native = desktop/mobile, spa = single-page app",
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              application: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  clientId: { type: "string" },
                  clientSecret: {
                    type: "string",
                    description:
                      "Only returned once at creation. Store it securely.",
                  },
                  name: { type: "string" },
                  redirectUrls: { type: "array", items: { type: "string" } },
                  type: { type: "string" },
                },
              },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { name, redirectUris, type = "native" } = req.body as {
        name: string;
        redirectUris: string[];
        type?: string;
      };

      // Validate redirect URIs — allow https://, http://127.0.0.1/localhost, and custom schemes
      for (const uri of redirectUris) {
        try {
          const parsed = new URL(uri);
          const isLoopback =
            parsed.protocol === "http:" &&
            (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
          const isHttps = parsed.protocol === "https:";
          const isCustomScheme =
            !["https:", "http:"].includes(parsed.protocol);
          if (!isLoopback && !isHttps && !isCustomScheme) {
            return reply.status(400).send({
              error: `Redirect URI "${uri}" must use https://, http://127.0.0.1, or a custom scheme.`,
            });
          }
        } catch {
          return reply.status(400).send({ error: `Invalid redirect URI: "${uri}"` });
        }
      }

      const result = await auth.api.registerOAuthApplication({
        body: {
          name,
          redirectURLs: redirectUris,
          userId: req.user!.id,
          metadata: JSON.stringify({ type }),
        },
      });

      return reply.status(201).send({ application: result });
    }
  );

  // ── DELETE /v1/oauth/applications/:id ───────────────────────────────────────
  app.delete(
    "/oauth/applications/:id",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["OAuth"],
        summary: "Delete (revoke) an OAuth application",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      // Verify ownership before deletion
      const existing = await oauthAppsCollection().findOne({ id, userId: req.user!.id });
      if (!existing) {
        return reply.status(404).send({ error: "Application not found" });
      }

      await oauthAppsCollection().deleteOne({ id });

      return reply.send({ ok: true });
    }
  );
}

