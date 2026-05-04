import "dotenv/config";
import { fileURLToPath } from "url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { connectDB } from "./lib/db.js";
import { auth } from "./lib/auth.js";
import { appContext } from "./middleware/app-context.js";
import { healthRoutes } from "./routes/health.js";
import { userRoutes } from "./routes/users.js";
import { ticketRoutes } from "./routes/tickets.js";
import { teamRoutes } from "./routes/teams.js";
import { clockRoutes } from "./routes/clock.js";
import { messageRoutes } from "./routes/messages.js";
import { notificationRoutes } from "./routes/notifications.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { oauthAppRoutes } from "./routes/oauth-apps.js";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // Swagger — must be registered before routes
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Timecore API",
        description: "Shared backend API",
        version: "1.0.0",
      },
      servers: [
        { url: "https://timehubbackend.os.mieweb.org", description: "Production" },
        { url: `http://localhost:${process.env.PORT || 3001}`, description: "Local dev" },
      ],
      tags: [
        { name: "Health", description: "Health check endpoints" },
        {
          name: "Auth",
          description: "Better Auth endpoints (sign-up, sign-in, sign-out, session)",
        },
        { name: "Users", description: "User session and profile endpoints" },
        { name: "Teams", description: "Team management endpoints" },
        { name: "Tickets", description: "Ticket CRUD, timer, and admin endpoints" },
        {
          name: "Clock",
          description: "Clock in/out, ticket timers, timesheet, and SSE live stream",
        },
        { name: "Messages", description: "Admin-member threaded messaging and SSE stream" },
        {
          name: "Notifications",
          description: "User notification inbox, mark-read, delete, and SSE stream",
        },
        {
          name: "Attachments",
          description: "Generic media attachments for clock entries and tickets",
        },        { name: "OAuth", description: "OAuth 2.0 application management" },      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Expose the bearer token header so Capacitor WebViews can read it after sign-in.
    exposedHeaders: ["set-auth-token"],
  });

  // Attach X-App-Id (timeharbor | timehuddle) to every request
  app.addHook("preHandler", appContext);

  // Better Auth handles all /api/auth/* routes.
  // We convert the Fastify request into a Web Request and pass it to
  // auth.handler directly, avoiding the body-stream issue that occurs
  // when using toNodeHandler (Fastify already consumes the body).
  async function betterAuthHandler(req: any, reply: any) {
    // Use the request URL as-is — better-auth's dynamic baseURL config
    // reads x-forwarded-host/proto headers to derive the correct origin.
    const url = `${process.env.BETTER_AUTH_URL || `http://localhost:${process.env.PORT || 3001}`}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(
      req.headers as Record<string, string | string[] | undefined>
    )) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v));
        } else {
          headers.set(key, value);
        }
      }
    }

    // Capacitor's native HTTP plugin may not send an Origin header.
    // Better Auth rejects requests with missing origin, so set a fallback.
    if (!headers.has("origin") || headers.get("origin") === "null") {
      headers.set("origin", "capacitor://localhost");
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const webRequest = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });

    const response = await auth.handler(webRequest);

    reply.status(response.status);
    response.headers.forEach((value: string, key: string) => {
      // Skip CORS headers — @fastify/cors already sets them.
      // Forwarding better-auth's CORS headers too causes duplicate
      // Access-Control-Allow-Origin, which WKWebView rejects as "Load failed".
      if (key.toLowerCase().startsWith("access-control-")) return;
      reply.header(key, value);
    });

    const text = await response.text();
    reply.send(text);
  }

  // Catch-all for any auth route not explicitly listed below (hidden from docs)
  app.all("/api/auth/*", { schema: { hide: true } }, betterAuthHandler);

  // ── Documented Better Auth endpoints ────────────────────────────────
  app.post(
    "/api/auth/sign-up/email",
    {
      schema: {
        tags: ["Auth"],
        summary: "Sign up with email & password",
        body: {
          type: "object",
          required: ["email", "password", "name"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            name: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                  emailVerified: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.post(
    "/api/auth/sign-in/email",
    {
      schema: {
        tags: ["Auth"],
        summary: "Sign in with email & password",
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                  emailVerified: { type: "boolean" },
                },
              },
            },
          },
          401: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.post(
    "/api/auth/sign-out",
    {
      schema: {
        tags: ["Auth"],
        summary: "Sign out (clear session cookie)",
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.get(
    "/api/auth/get-session",
    {
      schema: {
        tags: ["Auth"],
        summary: "Get current session",
        description: "Returns the authenticated user and session. Requires a valid session cookie.",
        response: {
          200: {
            type: "object",
            properties: {
              session: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  userId: { type: "string" },
                  token: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                  emailVerified: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.post(
    "/api/auth/request-password-reset",
    {
      schema: {
        tags: ["Auth"],
        summary: "Request password reset email",
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            redirectTo: {
              type: "string",
              description: "URL to redirect to from the reset email link",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "boolean" },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.post(
    "/api/auth/reset-password",
    {
      schema: {
        tags: ["Auth"],
        summary: "Reset password using token",
        body: {
          type: "object",
          required: ["token", "newPassword"],
          properties: {
            token: { type: "string" },
            newPassword: { type: "string", minLength: 8 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "boolean" },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.post(
    "/api/auth/sign-in/social",
    {
      schema: {
        tags: ["Auth"],
        summary: "Initiate social OAuth sign-in",
        description:
          "Returns the OAuth provider URL to redirect to. The provider redirects back to /api/auth/callback/{provider}.",
        body: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: ["google", "github"] },
            callbackURL: {
              type: "string",
              description: "URL to redirect to after successful auth",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { url: { type: "string" }, redirect: { type: "boolean" } },
          },
        },
      },
    },
    betterAuthHandler
  );

  app.get(
    "/api/auth/callback/:provider",
    {
      schema: {
        tags: ["Auth"],
        summary: "OAuth callback",
        description:
          "Handles the redirect back from Google/GitHub after user authorises. Sets session cookie and redirects to callbackURL.",
        params: {
          type: "object",
          properties: {
            provider: { type: "string", enum: ["google", "github"] },
          },
        },
        response: {
          302: { type: "null", description: "Redirect to callbackURL with session cookie set" },
        },
      },
    },
    betterAuthHandler
  );

  app.get(
    "/api/auth/ok",
    {
      schema: {
        tags: ["Auth"],
        summary: "Health check for auth service",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
      },
    },
    betterAuthHandler
  );

  // Health check
  await app.register(healthRoutes);

  // App routes
  await app.register(userRoutes, { prefix: "/v1" });
  await app.register(teamRoutes, { prefix: "/v1" });
  await app.register(ticketRoutes, { prefix: "/v1" });
  await app.register(clockRoutes, { prefix: "/v1" });
  await app.register(messageRoutes, { prefix: "/v1" });
  await app.register(notificationRoutes, { prefix: "/v1" });
  await app.register(attachmentRoutes, { prefix: "/v1" });
  await app.register(oauthAppRoutes, { prefix: "/v1" });

  return app;
}

async function bootstrap() {
  await connectDB();
  const app = await buildApp();
  const port = Number(process.env.PORT) || 4000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`API running on http://localhost:${port}`);
  console.log(`Swagger UI at http://localhost:${port}/docs`);
}

// Only start the server when this file is run directly (not imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap().catch(console.error);
}
