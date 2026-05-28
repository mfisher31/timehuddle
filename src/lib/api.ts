/**
 * Typed fetch wrappers for the timecore backend.
 *
 * Base URL is read from the VITE_TIMECORE_URL env var (set in .env),
 * falling back to localhost:4000 for local development.
 */
import { autoReconnectWs, type AutoReconnectWs } from './autoReconnectWs.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export const TIMECORE_BASE_URL: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_TIMECORE_URL) ||
  'http://localhost:4000';

const WS_BASE_URL = TIMECORE_BASE_URL.replace(/^http/, 'ws');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimecoreUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  image?: string | null;
  backgroundUrl?: string | null;
  /** Canonical username — null until the user has claimed one. */
  username: string | null;
  organizationMembership?: {
    organizationId: string;
    organizationKey: string;
    role: 'owner' | 'admin';
  } | null;
}

export interface AuthAccount {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  scopes: string[];
}

export interface PublicUser {
  id: string;
  name: string;
  /** Canonical username/handle. Null until the user claims one. */
  username: string | null;
  image: string | null;
  backgroundUrl: string | null;
  bio: string;
  website: string;
  reportsTo: { id: string; name: string; username: string | null } | null;
  teamMemberships: Array<{ id: string; name: string; role: 'admin' | 'member' }>;
  /** Teams shared between the viewer and this user (non-personal). Empty for own profile. */
  sharedTeams?: Array<{ id: string; name: string; isAdmin: boolean }>;
}

function toAbsoluteUrl(url: string | null): string | null {
  if (!url || /^https?:\/\//i.test(url)) return url;
  return `${TIMECORE_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function withAbsoluteImage(user: PublicUser): PublicUser {
  const image = toAbsoluteUrl(user.image);
  const backgroundUrl = toAbsoluteUrl(user.backgroundUrl);
  if (image === user.image && backgroundUrl === user.backgroundUrl) return user;
  return { ...user, image, backgroundUrl };
}

/** API error that carries the HTTP status code. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Token storage (for Capacitor / custom-scheme WebViews where cookies are unreliable) ──

const TOKEN_KEY = 'timecore_session_token';

export const sessionToken = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

// ─── Base request ─────────────────────────────────────────────────────────────

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const hasBody = options.body != null;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const token = sessionToken.get();
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () =>
      controller.abort(new Error('Request timed out. Please check your connection and try again.')),
    8000,
  );
  // overwrite the merged headers object (which would drop Authorization).
  const { headers: optHeaders, ...restOptions } = options;
  try {
    const res = await fetch(`${TIMECORE_BASE_URL}${path}`, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(hasBody && !isFormData ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...optHeaders,
      },
      ...restOptions,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
        res.status,
      );
    }

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

/** fetch() with an 8-second abort timeout — prevents indefinite hangs on slow connections. */
async function timedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () =>
      controller.abort(new Error('Request timed out. Please check your connection and try again.')),
    8000,
  );
  try {
    return await fetch(url, { signal: controller.signal, ...options });
  } finally {
    clearTimeout(timeoutId);
  }
}

export const authApi = {
  /** Sign in — stores session token from `set-auth-token` header (better-auth bearer plugin). */
  signIn: async (email: string, password: string) => {
    const res = await timedFetch(`${TIMECORE_BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
      );
    }
    const token = res.headers.get('set-auth-token');
    if (token) sessionToken.set(token);
    return res.json();
  },

  /** Sign up — stores session token from `set-auth-token` header (better-auth bearer plugin). */
  signUp: async (email: string, password: string, name: string) => {
    const res = await timedFetch(`${TIMECORE_BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
      );
    }
    const token = res.headers.get('set-auth-token');
    if (token) sessionToken.set(token);
    return res.json();
  },

  /**
   * Initiate a social OAuth sign-in (e.g. GitHub).
   * Returns the provider redirect URL; caller should set window.location.href to it.
   */
  signInWithSocial: async (provider: 'github' | 'google', callbackURL: string): Promise<string> => {
    const res = await fetch(`${TIMECORE_BASE_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, callbackURL }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  },

  /** Initiate linking a social provider to the currently authenticated user. */
  linkSocial: async (provider: 'github' | 'google', callbackURL: string): Promise<string> => {
    const data = await request<{ url: string }>('/api/auth/link-social', {
      method: 'POST',
      body: JSON.stringify({ provider, callbackURL }),
    });
    return data.url;
  },

  /** Remove a linked auth provider from the current account. */
  unlinkAccount: async (providerId: string): Promise<void> => {
    await request('/api/auth/unlink-account', {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    });
  },

  /** List auth providers linked to the current account. */
  listAccounts: (): Promise<AuthAccount[]> => request<AuthAccount[]>('/api/auth/list-accounts'),

  /** Sign out — clears better-auth session cookie and stored token. */
  signOut: async () => {
    await request('/api/auth/sign-out', { method: 'POST' }).catch(() => {});
    sessionToken.clear();
  },

  /**
   * Request a password-reset email.
   * @param redirectTo - URL to include in the email link as the callbackURL.
   *                     better-auth will append ?token=TOKEN before redirecting.
   */
  requestPasswordReset: (email: string, redirectTo: string) =>
    request('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email, redirectTo }),
    }),

  /**
   * Reset password using the token from the reset-password email.
   * @param token - from the ?token= query param on the reset-password landing page.
   */
  resetPassword: (token: string, newPassword: string) =>
    request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),

  /**
   * Fetch the currently authenticated user.
   * Returns null on 401 (not authenticated), throws on other errors.
   */
  getMe: async (): Promise<{ user: TimecoreUser } | null> => {
    try {
      const data = await request<{ user: TimecoreUser }>('/v1/me');
      if (data?.user?.image && !/^https?:\/\//i.test(data.user.image)) {
        data.user.image = `${TIMECORE_BASE_URL}${data.user.image.startsWith('/') ? '' : '/'}${data.user.image}`;
      }
      if (data?.user?.backgroundUrl && !/^https?:\/\//i.test(data.user.backgroundUrl)) {
        data.user.backgroundUrl = `${TIMECORE_BASE_URL}${data.user.backgroundUrl.startsWith('/') ? '' : '/'}${data.user.backgroundUrl}`;
      }
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
};

// ─── User API ─────────────────────────────────────────────────────────────────

export const userApi = {
  /** Upload a new avatar image for the current user (multipart/form-data). Returns { avatarUrl }. */
  uploadAvatar: async (blob: Blob): Promise<{ avatarUrl: string }> => {
    const formData = new FormData();
    formData.append('avatar', blob, 'avatar.png');
    const token = sessionToken.get();
    const res = await fetch(`${TIMECORE_BASE_URL}/v1/me/avatar`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
        res.status,
      );
    }
    const data = (await res.json()) as { avatarUrl: string };
    return { avatarUrl: toAbsoluteUrl(data.avatarUrl) as string };
  },
  /** Delete the current user's avatar. */

  deleteAvatar: async (): Promise<void> => {
    const token = sessionToken.get();
    const res = await fetch(`${TIMECORE_BASE_URL}/v1/me/avatar`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  },
  /** Upload a new background image for the current user (multipart/form-data). Returns { backgroundUrl }. */
  uploadBackground: async (blob: Blob): Promise<{ backgroundUrl: string }> => {
    const formData = new FormData();
    formData.append('background', blob, 'background.jpg');
    const token = sessionToken.get();
    const res = await fetch(`${TIMECORE_BASE_URL}/v1/me/background`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        (body.message as string | undefined) ??
          (body.error as string | undefined) ??
          `HTTP ${res.status}`,
        res.status,
      );
    }
    const result = (await res.json()) as { backgroundUrl: string };
    return {
      backgroundUrl: `${TIMECORE_BASE_URL}${result.backgroundUrl.startsWith('/') ? '' : '/'}${result.backgroundUrl}`,
    };
  },
  /** Delete the current user's background image. */
  deleteBackground: async (): Promise<void> => {
    const token = sessionToken.get();
    const res = await fetch(`${TIMECORE_BASE_URL}/v1/me/background`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  },
  /** Get a single user's public profile by ID. */
  getUser: (id: string) =>
    request<{ user: PublicUser }>(`/v1/users/${encodeURIComponent(id)}`).then((r) =>
      withAbsoluteImage(r.user),
    ),

  /** Get a single user's public profile by username (requires auth). */
  getUserByUsername: (username: string) =>
    request<{ user: PublicUser }>(`/v1/users/by/username/${encodeURIComponent(username)}`).then(
      (r) => withAbsoluteImage(r.user),
    ),

  /** Batch-fetch public profiles by ID list (server caps at 200). */
  getUsers: (ids: string[]) =>
    request<{ users: PublicUser[] }>(`/v1/users?ids=${ids.map(encodeURIComponent).join(',')}`).then(
      (r) => r.users.map(withAbsoluteImage),
    ),

  /** Update the current user's profile fields. */
  updateProfile: (data: {
    name?: string;
    image?: string | null;
    bio?: string;
    website?: string;
    reportsToUserId?: string | null;
  }) =>
    request<{ user: PublicUser }>('/v1/me/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }).then((r) => r.user),
};

export type DefaultOrganizationRole = 'owner' | 'admin' | 'member';

export interface OrganizationAdminUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
  role: DefaultOrganizationRole;
  reportsToUserId?: string | null;
}

export interface AdminOrganization {
  id: string;
  key: string;
  name: string;
  ownersCount?: number;
  adminsCount?: number;
}

export const orgAdminApi = {
  getOrganization: () =>
    request<{ organization: AdminOrganization }>('/v1/admin/organization').then(
      (r) => r.organization,
    ),

  updateOrganizationName: (name: string) =>
    request<{ organization: AdminOrganization }>('/v1/admin/organization', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }).then((r) => r.organization),

  listUsers: () =>
    request<{ users: OrganizationAdminUser[] }>('/v1/admin/organization/users').then(
      (r) => r.users,
    ),

  setUserRole: (userId: string, role: DefaultOrganizationRole) =>
    request<{ user: { id: string; role: DefaultOrganizationRole } }>(
      `/v1/admin/organization/users/${encodeURIComponent(userId)}/role`,
      {
        method: 'PUT',
        body: JSON.stringify({ role }),
      },
    ).then((r) => r.user),

  updateReportsTo: (userId: string, reportsTo: string | null) =>
    request<{ user: { id: string; reportsToUserId: string | null } }>(
      `/v1/org/users/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ reportsToUserId: reportsTo }),
      },
    ).then((r) => r.user),
};

// ─── Public Organization API (for all authenticated users) ──────────────────

export const orgApi = {
  getOrganization: () =>
    request<{ organization: AdminOrganization }>('/v1/organization').then((r) => r.organization),

  listUsers: () =>
    request<{ users: OrganizationAdminUser[] }>('/v1/organization/users').then((r) => r.users),
};

// ─── Username API ─────────────────────────────────────────────────────────────

export const usernameApi = {
  /**
   * Check whether a username is available.
   * Returns { available: true } or { available: false, reason: string }.
   */
  check: (username: string) =>
    request<{ available: boolean; reason: string | null }>(
      `/v1/me/username-available?username=${encodeURIComponent(username)}`,
    ),

  /**
   * Claim a canonical username for the current user.
   * Throws if the username is taken, invalid, or already claimed.
   */
  claim: (username: string) =>
    request<{ username: string }>('/v1/me/username', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
};

// ─── Ticket API ───────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  teamId: string;
  title: string;
  description: string | null;
  github: string;
  status: string;
  priority: string | null;
  createdBy: string;
  assignedTo: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  sharedWithTimeharbor?: boolean;
}

export const ticketApi = {
  getTickets: (teamId: string) =>
    request<{ tickets: Ticket[] }>(`/v1/tickets?teamId=${encodeURIComponent(teamId)}`).then(
      (r) => r.tickets,
    ),

  getTicket: (id: string) =>
    request<{ ticket: Ticket }>(`/v1/tickets/${encodeURIComponent(id)}`).then((r) => r.ticket),

  createTicket: (data: { teamId: string; title: string; github?: string }) =>
    request<{ ticket: Ticket }>('/v1/tickets', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.ticket),

  updateTicket: (id: string, updates: { title?: string; github?: string; description?: string }) =>
    request<{ ticket: Ticket }>(`/v1/tickets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }).then((r) => r.ticket),

  updateStatusPriority: (id: string, updates: { status?: string; priority?: string }) =>
    request<{ ticket: Ticket }>(`/v1/tickets/${encodeURIComponent(id)}/status-priority`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }).then((r) => r.ticket),

  deleteTicket: (id: string) =>
    request<{ ok: boolean }>(`/v1/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  batchUpdateStatus: (data: { ticketIds: string[]; status: string; teamId: string }) =>
    request<{ modified: number }>('/v1/tickets/batch-status', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  assignTicket: (id: string, assignedToUserId: string | null) =>
    request<{ ticket: Ticket }>(`/v1/tickets/${encodeURIComponent(id)}/assign`, {
      method: 'PUT',
      body: JSON.stringify({ assignedToUserId }),
    }).then((r) => r.ticket),

  /** Get total accumulated seconds for a ticket from Timers. */
  getTotal: (ticketId: string) =>
    request<{ totalSeconds: number }>(
      `/v1/timers/tickets/${encodeURIComponent(ticketId)}/total`,
    ).then((r) => r.totalSeconds),

  /** Open a WebSocket connection for live ticket updates. Auto-reconnects on drop. */
  openLiveStream: (teamIds: string[]): AutoReconnectWs =>
    autoReconnectWs(() => {
      const token = sessionToken.get();
      const base = `${WS_BASE_URL}/v1/tickets/ws?teamIds=${teamIds.map(encodeURIComponent).join(',')}`;
      return token ? `${base}&token=${encodeURIComponent(token)}` : base;
    }),
};

// ─── Team API ─────────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  name: string;
  description: string | null;
  members: string[];
  admins: string[];
  code: string;
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
}

export const teamApi = {
  getTeams: () => request<{ teams: Team[] }>('/v1/teams').then((r) => r.teams),

  ensurePersonal: () =>
    request<{ team: Team }>('/v1/teams/ensure-personal', { method: 'POST' }).then((r) => r.team),

  createTeam: (data: { name: string; description?: string }) =>
    request<{ team: Team }>('/v1/teams', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.team),

  joinTeam: (teamCode: string) =>
    request<{ team: Team }>('/v1/teams/join', {
      method: 'POST',
      body: JSON.stringify({ teamCode }),
    }).then((r) => r.team),

  renameTeam: (id: string, newName: string) =>
    request<{ team: Team }>(`/v1/teams/${encodeURIComponent(id)}/name`, {
      method: 'PUT',
      body: JSON.stringify({ newName }),
    }).then((r) => r.team),

  deleteTeam: (id: string) =>
    request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getMembers: (id: string) =>
    request<{ members: TeamMember[] }>(`/v1/teams/${encodeURIComponent(id)}/members`).then((r) =>
      r.members.map((m) =>
        m.image && !/^https?:\/\//i.test(m.image)
          ? { ...m, image: `${TIMECORE_BASE_URL}${m.image.startsWith('/') ? '' : '/'}${m.image}` }
          : m,
      ),
    ),

  inviteMember: (id: string, email: string) =>
    request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(id)}/invite`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  removeMember: (id: string, userId: string) =>
    request<{ ok: boolean }>(
      `/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),

  setMemberRole: (id: string, userId: string, role: 'admin' | 'member') =>
    request<{ ok: boolean }>(
      `/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/role`,
      { method: 'PUT', body: JSON.stringify({ role }) },
    ),

  setMemberPassword: (id: string, userId: string, newPassword: string) =>
    request<{ ok: boolean }>(
      `/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/password`,
      { method: 'PUT', body: JSON.stringify({ newPassword }) },
    ),

  /** Open a WebSocket connection for live team updates. Auto-reconnects on drop. */
  openLiveStream: (): AutoReconnectWs =>
    autoReconnectWs(() => {
      const token = sessionToken.get();
      const base = `${WS_BASE_URL}/v1/teams/ws`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }),
};

// ─── Clock API ────────────────────────────────────────────────────────────────

export interface ClockEvent {
  id: string;
  userId: string;
  teamId?: string;
  startTime: number;
  /** @deprecated No longer returned by the API — use startTime. */
  originalStartTime?: number;
  accumulatedTime: number;
  breaks?: Array<{
    startTime: number;
    endTime: number | null;
    type?: 'rest' | 'meal';
    classificationSource?: 'auto' | 'manual';
    notes?: string;
  }>;
  workSeconds?: number;
  deductedBreakSeconds?: number;
  totalBreakSeconds?: number;
  isPaused?: boolean;
  /** @deprecated No longer set by the API — use breaks[].endTime === null to find active break. */
  pausedAt?: number | null;
  endTime: number | null;
}

export const clockApi = {
  /** Clock in. Returns the new clock event. */
  start: () =>
    request<{ event: ClockEvent }>('/v1/clock/start', {
      method: 'POST',
    }).then((r) => r.event),

  /** Clock out. */
  stop: () =>
    request<{ event: ClockEvent }>('/v1/clock/stop', {
      method: 'POST',
    }).then((r) => r.event),

  /** Pause an active clock session (break start). */
  pause: () =>
    request<{ event: ClockEvent }>('/v1/clock/pause', {
      method: 'POST',
    }).then((r) => r.event),

  /** Resume a paused clock session (break end). */
  resume: () =>
    request<{ event: ClockEvent }>('/v1/clock/resume', {
      method: 'POST',
    }).then((r) => r.event),

  /** Get active clock status. */
  getStatus: () =>
    request<{
      event: ClockEvent;
      workSeconds: number;
      isPaused: boolean;
    }>('/v1/clock/status'),

  /** Get the current user's active clock event (any team), or null. */
  getActive: () => request<{ event: ClockEvent | null }>('/v1/clock/active').then((r) => r.event),

  /** Get all clock events for the current user. */
  getEvents: () => request<{ events: ClockEvent[] }>('/v1/clock/events').then((r) => r.events),

  /** Get timesheet data for a user over a date range (epoch ms boundaries). */
  getTimesheet: (userId: string, startMs: number, endMs: number) =>
    request<{
      sessions: ClockEvent[];
      summary: {
        totalSeconds: number;
        totalBreakSeconds: number;
        totalSessions: number;
        completedSessions: number;
        averageSessionSeconds: number;
        workingDays: number;
      };
    }>(
      `/v1/clock/timesheet?userId=${encodeURIComponent(userId)}&startMs=${startMs}&endMs=${endMs}`,
    ),

  /** Update a clock event's timestamps and optional break intervals. */
  updateTimes: (
    clockEventId: string,
    data: {
      startTime?: number;
      endTime?: number | null;
      breaks?: Array<{ startTime: number; endTime: number | null }>;
    },
  ) =>
    request<{ event: ClockEvent }>(`/v1/clock/${encodeURIComponent(clockEventId)}/times`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }).then((r) => r.event),

  /** Delete a clock event. */
  deleteEvent: (clockEventId: string) =>
    request<{ ok: boolean }>(`/v1/clock/${encodeURIComponent(clockEventId)}`, {
      method: 'DELETE',
    }).then((r) => r.ok),

  /** Create a completed manual clock entry for a past time range. */
  createManualEntry: (data: { startTime: number; endTime: number }) =>
    request<{ event: ClockEvent }>('/v1/clock/manual', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.event),

  /** Open a WebSocket connection for live user clock state. Auto-reconnects on drop. */
  openLiveStream: (): AutoReconnectWs =>
    autoReconnectWs(() => {
      const token = sessionToken.get();
      const base = `${WS_BASE_URL}/v1/clock/ws`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }),
};

// ─── Notifications ────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string; // ISO
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  threadId: string;
  teamId: string;
  adminId: string;
  memberId: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  senderName: string;
  ticketId?: string;
  createdAt: string; // ISO
}

export const messageApi = {
  /** Fetch a thread's message history. Pass `before` ISO string for cursor-based pagination. */
  getThread: (teamId: string, adminId: string, memberId: string, before?: string) => {
    const qs = new URLSearchParams({
      teamId,
      adminId,
      memberId,
    });
    if (before) qs.set('before', before);
    return request<{ messages: Message[]; hasMore: boolean }>(`/v1/messages?${qs.toString()}`);
  },

  /** Send a message. */
  send: (data: {
    teamId: string;
    toUserId: string;
    text: string;
    adminId: string;
    ticketId?: string;
  }) =>
    request<{ message: Message }>('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.message),

  /** Open a WebSocket stream for a thread. Auto-reconnects on drop. */
  openStream: (threadId: string): AutoReconnectWs =>
    autoReconnectWs(() => {
      const token = sessionToken.get();
      const url = new URL(`${WS_BASE_URL}/v1/messages/ws`);
      url.searchParams.set('threadId', threadId);
      if (token) url.searchParams.set('token', token);
      return url.toString();
    }),
};

export type TeamInvitePreview = {
  notificationId: string;
  teamId: string;
  teamName: string;
  teamDescription: string;
  inviter: { id: string; name: string; email: string } | null;
  members: { id: string; name: string; email: string }[];
  admins: { id: string; name: string; email: string }[];
  alreadyMember: boolean;
};

export const notificationApi = {
  /** Fetch the user's notification inbox. */
  getInbox: () =>
    request<{ notifications: Notification[] }>('/v1/notifications').then((r) => r.notifications),

  /** Mark a single notification as read. */
  markOneRead: (id: string) =>
    request<{ ok: boolean }>(`/v1/notifications/${encodeURIComponent(id)}/read`, {
      method: 'PATCH',
    }),

  /** Mark all notifications as read. */
  markAllRead: () => request<{ ok: boolean }>('/v1/notifications/read', { method: 'POST' }),

  /** Bulk-delete notifications by ID. */
  deleteMany: (ids: string[]) =>
    request<{ deletedCount: number }>('/v1/notifications', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),

  /** Fetch team-invite preview for a notification. */
  getInvitePreview: (id: string) =>
    request<TeamInvitePreview>(`/v1/notifications/${encodeURIComponent(id)}/invite-preview`),

  /** Accept or ignore a team invite. */
  respondToInvite: (id: string, action: 'join' | 'ignore') =>
    request<{ ok: boolean }>(`/v1/notifications/${encodeURIComponent(id)}/invite-respond`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  /** Send a test push notification to the requesting user's devices. */
  testPush: () => request<{ ok: boolean }>('/v1/notifications/test-push', { method: 'POST' }),

  /** Open a WebSocket stream for new notifications. Auto-reconnects on drop. */
  openStream: (): AutoReconnectWs => {
    const token = sessionToken.get();
    return autoReconnectWs(() => {
      const url = new URL(`${WS_BASE_URL}/v1/notifications/ws`);
      if (token) url.searchParams.set('token', token);
      return url.toString();
    });
  },
};

// ─── Attachments ──────────────────────────────────────────────────────────────
export type AttachmentKind = 'clock' | 'ticket';
export type AttachmentType = 'video' | 'image' | 'link';

export interface Attachment {
  id: string;
  url: string;
  type: AttachmentType;
  title: string | null;
  thumbnail: string | null;
  attachedTo: { kind: AttachmentKind; id: string };
  addedBy: string;
  addedAt: string;
}

export const attachmentApi = {
  /** Fetch all attachments for a clock entry or ticket. */
  list: (kind: AttachmentKind, id: string) =>
    request<{ attachments: Attachment[] }>(
      `/v1/attachments?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
    ).then((r) => r.attachments),

  /** Add a new attachment to a clock entry or ticket. */
  add: (data: {
    url: string;
    type: AttachmentType;
    title?: string;
    attachedTo: { kind: AttachmentKind; id: string };
  }) =>
    request<{ attachment: Attachment }>('/v1/attachments', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.attachment),

  /** Delete an attachment by ID. */
  remove: (id: string) =>
    request<{ ok: boolean }>(`/v1/attachments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

// ─── Timer API ────────────────────────────────────────────────────────────────

/** A WorkItem is the per-user per-ticket per-day timesheet row. */
export interface WorkItem {
  id: string;
  userId: string;
  ticketId: string;
  displayTitle: string | null;
  date: string; // UTC "YYYY-MM-DD"
  note?: string;
  createdAt: string;
  updatedAt?: string;
}

/** A Timer is one start–stop interval inside a WorkItem. */
export interface Timer {
  id: string;
  workItemId: string;
  userId: string;
  date: string;
  startTime: number; // epoch ms
  endTime: number | null;
  durationSeconds?: number;
  createdAt: string;
}

export interface DayEntry {
  entry: WorkItem;
  sessions: Timer[];
}

export interface WeekDay {
  date: string;
  totalSeconds: number;
}

/** Returns the browser's IANA timezone string (e.g. "America/New_York"). */
function clientTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const timerApi = {
  /** Create a WorkItem for the given ticket + date. */
  createEntry: (data: { ticketId: string; date: string; note?: string }) =>
    request<{ entry: WorkItem }>('/v1/timers/entries', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.entry),

  /** Start a timer for a WorkItem. Closes any open timer first. */
  startSession: (entryId: string, now?: number) =>
    request<{ session: Timer; closedSessionId?: string }>(
      `/v1/timers/entries/${encodeURIComponent(entryId)}/start`,
      { method: 'POST', body: JSON.stringify({ now: now ?? Date.now(), tz: clientTz() }) },
    ),

  /** Stop a running timer. */
  stopSession: (sessionId: string, now?: number) =>
    request<{ session: Timer }>(`/v1/timers/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ now: now ?? Date.now() }),
    }).then((r) => r.session),

  /** Update a WorkItem's note, duration, and/or ticket (duration ignored while running). */
  updateEntry: (
    entryId: string,
    data: { note?: string | null; durationSeconds?: number; ticketId?: string },
  ) =>
    request<{ entry: WorkItem }>(`/v1/timers/entries/${encodeURIComponent(entryId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }).then((r) => r.entry),

  /** Delete a WorkItem and all of its timers. */
  deleteEntry: (entryId: string) =>
    request<{ deletedEntry: boolean; deletedSessions: number }>(
      `/v1/timers/entries/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    ),

  /** Get the currently running timer for the authenticated user, or null. */
  getRunning: () => request<{ session: Timer | null }>('/v1/timers/running').then((r) => r.session),

  /** Get all entries + sessions for a local day (YYYY-MM-DD). */
  getDay: (date: string) => {
    const tz = clientTz();
    return request<{ entries: DayEntry[] }>(
      `/v1/timers/day?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(tz)}`,
    ).then((r) => r.entries);
  },

  /** Get 7-day totals for the week starting at the given date (YYYY-MM-DD). */
  getWeek: (date: string) => {
    const tz = clientTz();
    return request<{ days: WeekDay[] }>(
      `/v1/timers/week?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(tz)}`,
    ).then((r) => r.days);
  },

  /** Get total seconds for a ticket from all closed Timers. */
  getTicketTotal: (ticketId: string) =>
    request<{ totalSeconds: number }>(
      `/v1/timers/tickets/${encodeURIComponent(ticketId)}/total`,
    ).then((r) => r.totalSeconds),

  /**
   * Copy entries from the most recent previous day into toDate.
   * Skips rows that already exist with the same ticket + note + sortOrder signature.
   */
  copyPrevious: (toDate: string) =>
    request<{ created: number }>('/v1/timers/copy-previous', {
      method: 'POST',
      body: JSON.stringify({ toDate }),
    }).then((r) => r.created),

  /**
   * Open a WebSocket connection for real-time timer updates.
   */
  openLiveStream: (): AutoReconnectWs =>
    autoReconnectWs(() => {
      const token = sessionToken.get();
      const base = `${WS_BASE_URL}/v1/timers/ws`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }),
};

// ─── PulseVault video uploads ──────────────────────────────────────────────────────────────────────────────

export const videoApi = {
  /** Shared authenticated TUS upload endpoint for ticket and media-library uploads. */
  uploadEndpoint: () => `${TIMECORE_BASE_URL.replace(/\/$/, '')}/v1/video/upload`,

  /** Reserve a videoid for a ticket upload before starting TUS.
   *  Pass `existingVideoid` when resuming a recording session so the backend
   *  re-registers the same id instead of creating a new one.
   */
  reserve: (ticketId: string, existingVideoid?: string) =>
    request<{ videoid: string; uploadToken: string; uploadLink?: string }>('/v1/video/reserve', {
      method: 'POST',
      body: JSON.stringify(
        existingVideoid
          ? { target: 'ticket', ticketId, videoid: existingVideoid }
          : { target: 'ticket', ticketId },
      ),
    }),

  /** Reserve a videoid for a media library upload (no ticket context). */
  reserveForLibrary: () =>
    request<{ videoid: string; uploadToken: string }>('/v1/video/reserve', {
      method: 'POST',
      body: JSON.stringify({ target: 'library' }),
    }),
};

// ─── Media Library ────────────────────────────────────────────────────────────

export interface MediaItem {
  id: string;
  userId: string;
  type: 'video' | 'image';
  mimeType: string;
  url: string;
  videoid: string | null;
  filename: string;
  size: number;
  title: string | null;
  caption: string | null;
  altText: string | null;
  thumbnail: string | null;
  uploadedAt: string;
}

function withAbsoluteMediaItem(item: MediaItem): MediaItem {
  const thumbnail = toAbsoluteUrl(item.thumbnail);
  const url = toAbsoluteUrl(item.url) ?? item.url;
  if (thumbnail === item.thumbnail && url === item.url) return item;
  return { ...item, thumbnail, url };
}

export const mediaApi = {
  /** POST /v1/media — upload image file to media library */
  uploadImage: async (file: File): Promise<MediaItem> => {
    const form = new FormData();
    form.append('file', file, file.name || 'image');
    const response = await request<{ item: MediaItem }>('/v1/media', {
      method: 'POST',
      body: form,
    });
    return withAbsoluteMediaItem(response.item);
  },

  /** GET /v1/media — list media library items for the current user */
  list: () =>
    request<{ items: MediaItem[] }>(`/v1/media`).then((r) => r.items.map(withAbsoluteMediaItem)),

  /** GET /v1/media/user/:userId — list media items for a specific profile user */
  listForUser: (userId: string) =>
    request<{ items: MediaItem[] }>(`/v1/media/user/${encodeURIComponent(userId)}`).then((r) =>
      r.items.map(withAbsoluteMediaItem),
    ),

  /** PATCH /v1/media/:id — update title, caption, altText */
  update: (id: string, data: { title?: string; caption?: string; altText?: string }) =>
    request<{ item: MediaItem }>(`/v1/media/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }).then((r) => withAbsoluteMediaItem(r.item)),

  /** DELETE /v1/media/:id */
  remove: (id: string) =>
    request<{ ok: boolean }>(`/v1/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** POST /v1/media/:id/thumbnail — upload a JPEG thumbnail blob */
  uploadThumbnail: async (id: string, blob: Blob): Promise<MediaItem> => {
    const form = new FormData();
    form.append('file', blob, 'thumbnail.jpg');
    const response = await request<{ item: MediaItem }>(
      `/v1/media/${encodeURIComponent(id)}/thumbnail`,
      {
        method: 'POST',
        body: form,
      },
    );
    return withAbsoluteMediaItem(response.item);
  },
};

// ─── Activity Log ─────────────────────────────────────────────────────────────

export interface ActivityLogItem {
  id: string;
  userId: string;
  teamId?: string;
  type: string;
  actor: { id: string; name: string; avatar?: string };
  payload: Record<string, unknown>;
  occurredAt: string; // ISO 8601
  source: string;
}

export const activityApi = {
  /**
   * Fetch a page of activity log events for the current user, newest first.
   *
   * @param limit  - Max items per page (1–100, default 50).
   * @param before - Cursor: ISO timestamp; fetch events older than this.
   */
  getLog: (params: { limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.before) qs.set('before', params.before);
    const query = qs.toString();
    return request<{ events: ActivityLogItem[]; nextCursor: string | null }>(
      `/v1/activity/log${query ? `?${query}` : ''}`,
    );
  },

  /**
   * Fetch a page of activity log events for a specific user (teammates only).
   *
   * @param userId - The target user's ID.
   * @param limit  - Max items per page (1–50, default 20).
   * @param before - Cursor: ISO timestamp; fetch events older than this.
   */
  getUserActivity: (userId: string, params: { limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.before) qs.set('before', params.before);
    const query = qs.toString();
    return request<{ events: ActivityLogItem[]; nextCursor: string | null }>(
      `/v1/users/${encodeURIComponent(userId)}/activity${query ? `?${query}` : ''}`,
    );
  },

  /** Ticket IDs + titles from the user's last 48 h of timer work. */
  getUserWorkSummary: (userId: string) =>
    request<{ items: { id: string; title: string }[] }>(
      `/v1/work/summary/user/${encodeURIComponent(userId)}`,
    ),

  /** Activity events for a specific ticket (team members only). */
  getTicketActivity: (ticketId: string, limit = 50) =>
    request<{ events: ActivityLogItem[] }>(
      `/v1/tickets/${encodeURIComponent(ticketId)}/activity?limit=${limit}`,
    ),
};

// ─── Presence ─────────────────────────────────────────────────────────────────

export const presenceApi = {
  /**
   * Open a WebSocket presence stream.
   * Sends periodic { type: "ping" } heartbeats to stay marked online.
   * Receives { type: "snapshot", online: string[] } on connect,
   * then { type: "presence", userId: string, online: boolean } on changes.
   */
  openStream: (watchIds: string[]): AutoReconnectWs => {
    const token = sessionToken.get();
    return autoReconnectWs(() => {
      const url = new URL(`${WS_BASE_URL}/v1/presence/ws`);
      if (token) url.searchParams.set('token', token);
      if (watchIds.length > 0) url.searchParams.set('watch', watchIds.join(','));
      return url.toString();
    });
  },
};

// ─── Channel types ────────────────────────────────────────────────────────────

export interface Channel {
  id: string;
  teamId: string;
  name: string;
  description?: string;
  isDefault: boolean;
  /** userIds who can access this channel; empty array means team-wide */
  members: string[];
  createdBy: string;
  createdAt: string;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  teamId: string;
  fromUserId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

// ─── Channel API ──────────────────────────────────────────────────────────────

export const channelApi = {
  getChannels: (teamId: string): Promise<Channel[]> =>
    request<{ channels: Channel[] }>(`/v1/channels?teamId=${encodeURIComponent(teamId)}`).then(
      (r) => r.channels,
    ),

  createChannel: (data: {
    teamId: string;
    name: string;
    description?: string;
    members?: string[];
  }): Promise<Channel> =>
    request<{ channel: Channel }>('/v1/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then((r) => r.channel),

  getMessages: (
    channelId: string,
    teamId: string,
    before?: string,
  ): Promise<{ messages: ChannelMessage[]; hasMore: boolean }> => {
    const url = new URL(
      `/v1/channels/${encodeURIComponent(channelId)}/messages`,
      TIMECORE_BASE_URL,
    );
    url.searchParams.set('teamId', teamId);
    if (before) url.searchParams.set('before', before);
    return request<{ messages: ChannelMessage[]; hasMore: boolean }>(url.pathname + url.search);
  },

  sendMessage: (
    channelId: string,
    data: { teamId: string; text: string },
  ): Promise<ChannelMessage> =>
    request<{ message: ChannelMessage }>(`/v1/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then((r) => r.message),

  openStream: (channelId: string, teamId: string): AutoReconnectWs =>
    autoReconnectWs(() => {
      const url = new URL(`${WS_BASE_URL}/v1/channels/ws`);
      url.searchParams.set('channelId', channelId);
      url.searchParams.set('teamId', teamId);
      const token = sessionToken.get();
      if (token) url.searchParams.set('token', token);
      return url.toString();
    }),
};

// ─── Personal Access Tokens ───────────────────────────────────────────────────

export interface PersonalAccessToken {
  _id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export const tokenApi = {
  list: (): Promise<PersonalAccessToken[]> =>
    request<{ tokens: PersonalAccessToken[] }>('/v1/me/tokens').then((r) => r.tokens),

  create: (name: string): Promise<{ token: string; name: string }> =>
    request<{ token: string; name: string }>('/v1/me/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  revoke: (id: string): Promise<void> =>
    request<{ success: boolean }>(`/v1/me/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(() => undefined),
};

// ─── TimeHarbor Share ─────────────────────────────────────────────────────────

/**
 * Flag a single ticket as shared with TimeHarbor.
 * One-way: this only sets the flag on the TimeHuddle record; TimeHarbor pulls it.
 */
export const shareTicketWithTimeharbor = (id: string, shared: boolean): Promise<void> =>
  request<{ success: boolean }>(`/v1/tickets/${encodeURIComponent(id)}/timeharbor-share`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared }),
  }).then(() => undefined);

/**
 * Flag multiple tickets as shared with (or unshared from) TimeHarbor in one request.
 */
export const bulkShareTicketsWithTimeharbor = (
  ticketIds: string[],
  shared: boolean,
): Promise<void> =>
  request<{ modifiedCount: number }>('/v1/tickets/bulk-timeharbor-share', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketIds, shared }),
  }).then(() => undefined);
