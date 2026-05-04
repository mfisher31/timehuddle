import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { bearer, oidcProvider } from "better-auth/plugins";
import { client } from "./db.js";
import { sendEmail } from "./email.js";
import { teamService } from "../services/team.service.js";

export const auth = betterAuth({
  database: mongodbAdapter(client.db()),

  plugins: [
    // Emit `set-auth-token` response header on sign-in and accept
    // `Authorization: Bearer <token>` on all authenticated requests.
    // Required for Capacitor (custom-scheme WebViews where cookies are unreliable).
    bearer(),

    // OIDC provider — enables "Login with TimeHuddle" for third-party clients
    // such as the Qt desktop application. Exposes the standard OAuth 2.0 endpoints:
    //   GET  /api/auth/oauth2/authorize   — authorization endpoint
    //   POST /api/auth/oauth2/token       — token exchange
    //   GET  /api/auth/oauth2/userinfo    — user info (Bearer token)
    //   GET  /api/auth/.well-known/openid-configuration
    oidcProvider({
      loginPage: "/login",
      consentPage: "/oauth/consent",

      // The Qt desktop app is registered as a trusted public client.
      // Public clients use PKCE and have no client secret.
      // client_id is stable; rotate QT_OAUTH_CLIENT_ID env var to invalidate.
      trustedClients: [
        {
          clientId: process.env.QT_OAUTH_CLIENT_ID ?? "qt-timehuddle-desktop",
          clientSecret: process.env.QT_OAUTH_CLIENT_SECRET ?? "",
          name: "TimeHuddle Desktop",
          type: "native",
          redirectUrls: [
            // Custom URI scheme (Windows/macOS/Linux with URI handler registered)
            "timehuddle-qt://callback",
            // Loopback redirect — fallback for systems that can't register URI schemes
            "http://127.0.0.1",
          ],
          disabled: false,
          skipConsent: false,
          metadata: {},
        },
      ],
    }),
  ],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url, token }) => {
      const resetUrl =
        url ?? `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${token}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        html: `<p>You requested a password reset.</p><p><a href="${resetUrl}">Click here to reset your password</a></p><p>If you did not request this, please ignore this email.</p>`,
      });
    },
  },

  // GitHub OAuth social provider
  // Credentials are read from GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET env vars.
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  },

  // username is claimed post-signup via a dedicated endpoint — stored on the user document.
  user: {
    additionalFields: {
      username: {
        type: "string",
        required: false,
        unique: true,
        input: false,
      },
    },
  },

  // Bootstrap a personal workspace the first time a user account is created.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await teamService.ensurePersonalWorkspace(user.id);
          } catch (err) {
            // Non-fatal — the user can still sign in; personal org is idempotent.
            console.error("[auth] Failed to bootstrap personal workspace for", user.id, err);
          }
        },
      },
    },
  },

  secret: process.env.BETTER_AUTH_SECRET!,

  // Static baseURL — must always be the FRONTEND domain so that:
  //   1. OAuth redirect_uri points to the frontend (cookies stay same-origin)
  //   2. State cookies set during sign-in are on the same domain as the callback
  // In production: BETTER_AUTH_URL=https://timeharborappuat.os.mieweb.org
  // Locally: BETTER_AUTH_URL=http://localhost:8080 (the proxy)
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8080",

  trustedOrigins: process.env.TRUSTED_ORIGINS ? process.env.TRUSTED_ORIGINS.split(",") : [],

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    defaultCookieAttributes: {
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    },
  },
});
