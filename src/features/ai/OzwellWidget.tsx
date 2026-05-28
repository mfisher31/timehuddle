/**
 * OzwellWidget — mounts the Ozwell AI chat widget into the authenticated shell.
 *
 * Architecture:
 *   • Injects the CDN loader script once on mount (cleans up on unmount).
 *   • Syncs live context (user, team, page) via OzwellChat.updateContext()
 *     whenever those values change.
 *   • Handles all ozwell-tool-call DOM events dispatched by the widget when
 *     the AI calls a TimeHuddle tool.
 *
 * The widget renders itself (floating bubble, bottom-right). This component
 * returns null — no JSX output.
 *
 * To configure: set VITE_OZWELL_AGENT_KEY in your .env.local.
 * https://mieweb.github.io/ozwellai-api/frontend/cdn-embed
 */
import { useCallback, useEffect, useRef } from 'react';

import { clockApi, teamApi, ticketApi, timerApi } from '../../lib/api';
import { useSession } from '../../lib/useSession';
import { createTicketFromGithub, fetchGithubIssue, isGithubIssueUrl } from '../tickets/githubIssue';
import { useTeam } from '../../lib/TeamContext';
import { useRouter } from '../../ui/router';

/** Format a number of seconds into a human-readable string, e.g. "2h 15m" or "45m". */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ── Window interface augmentation ────────────────────────────────────────────

declare global {
  interface Window {
    OzwellChatConfig?: {
      apiKey: string;
      debug?: boolean;
      tools?: unknown[];
    };
    OzwellChat?: {
      open: () => void;
      close: () => void;
      updateContext: (ctx: Record<string, unknown>) => void;
    };
  }
}

// ── Tool call event type ─────────────────────────────────────────────────────

interface OzwellToolCallDetail {
  name: string;
  arguments: Record<string, unknown>;
  respond: (result: unknown) => void;
}

// ── OzwellWidget ─────────────────────────────────────────────────────────────

const LOADER_URL = 'https://ozwellapi.opensource.mieweb.org/embed/ozwell-loader.js';
const SCRIPT_ID = 'ozwell-loader';
const MOBILE_OVERRIDE_STYLE_ID = 'ozwell-mobile-override';
const JERRY_BUTTON_STYLE_ID = 'ozwell-jerry-button';

/** Inject CSS for the Jerry animated avatar button. */
function injectJerryButtonStyles() {
  if (document.getElementById(JERRY_BUTTON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = JERRY_BUTTON_STYLE_ID;
  style.textContent = `
    #ozwell-chat-button {
      background: #F5A623 !important;
      border-radius: 14px !important;
      box-shadow: 0 4px 16px rgba(245, 166, 35, 0.4) !important;
      flex-direction: column !important;
      gap: 2px !important;
      animation: jerry-bob 3.5s ease-in-out infinite !important;
    }
    #ozwell-chat-button:hover {
      box-shadow: 0 6px 22px rgba(245, 166, 35, 0.55) !important;
    }
    #ozwell-chat-button.wiggling {
      animation: ozwell-wiggle 0.8s ease-in-out !important;
    }
    @keyframes jerry-bob {
      0%, 100% { transform: translateY(0px); }
      50%       { transform: translateY(-5px); }
    }
    .jerry-eyes {
      display: flex;
      gap: 8px;
    }
    .jerry-eye {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #3B2000;
      animation: jerry-blink 5s ease-in-out infinite;
      transform-origin: center;
    }
    .jerry-eye.r { animation-delay: 0.07s; }
    @keyframes jerry-blink {
      0%, 88%, 100% { transform: scaleY(1); }
      93%           { transform: scaleY(0.08); }
    }
    .jerry-j {
      font-size: 24px;
      font-weight: 700;
      line-height: 1;
      color: #3B2000;
      font-family: Georgia, 'Times New Roman', serif;
    }
  `;
  document.head.appendChild(style);
}

/** Replace the loader's default favicon icon with the Jerry animated avatar. */
function injectJerryButtonContent() {
  const button = document.getElementById('ozwell-chat-button');
  if (!button) return;
  button.innerHTML = `
    <div class="jerry-eyes">
      <div class="jerry-eye l"></div>
      <div class="jerry-eye r"></div>
    </div>
    <div class="jerry-j">J</div>
  `;
}

/** Hide tool-call-only turns that the Ozwell platform renders as "(no response)". */
function hideNoResponseBubbles(root: HTMLElement) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (el.textContent?.trim() === '(no response)') {
      const parent = el.parentElement;
      // Skip inner elements — only hide the outermost wrapper for this text
      if (parent && parent !== root && parent.textContent?.trim() === '(no response)') continue;
      el.style.setProperty('display', 'none', 'important');
    }
  }
}

/** Override the loader's full-screen mobile styles — bottom-sheet pattern. */
function injectMobileOverride() {
  if (document.getElementById(MOBILE_OVERRIDE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MOBILE_OVERRIDE_STYLE_ID;
  style.textContent = `
    @media (max-width: 767px) {
      /* FAB: sit above the bottom nav bar */
      #ozwell-chat-button {
        bottom: calc(72px + env(safe-area-inset-bottom)) !important;
        right: 20px !important;
        width: 52px !important;
        height: 52px !important;
      }

      /* Backdrop that dims the app when chat is open */
      #ozwell-chat-wrapper::before {
        content: '' !important;
        display: block !important;
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0, 0, 0, 0.45) !important;
        z-index: -1 !important;
        transition: opacity 0.3s !important;
      }
      #ozwell-chat-wrapper.hidden::before {
        opacity: 0 !important;
      }
      #ozwell-chat-wrapper.visible::before {
        opacity: 1 !important;
      }

      /* Bottom sheet: slides up from the bottom */
      #ozwell-chat-wrapper {
        position: fixed !important;
        top: auto !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100% !important;
        height: 72vh !important;
        max-height: 600px !important;
        border-radius: 20px 20px 0 0 !important;
        border: none !important;
        border-top: 1px solid #e5e7eb !important;
        box-shadow: 0 -4px 32px rgba(0, 0, 0, 0.18) !important;
        padding-bottom: env(safe-area-inset-bottom) !important;
        z-index: 9999 !important;
      }
      #ozwell-chat-wrapper.hidden {
        opacity: 1 !important;
        transform: translateY(100%) !important;
        pointer-events: none !important;
      }
      #ozwell-chat-wrapper.visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }

      /* Drag handle pill at the top of the sheet */
      .ozwell-chat-header::before {
        content: '' !important;
        display: block !important;
        width: 36px !important;
        height: 4px !important;
        background: rgba(255,255,255,0.5) !important;
        border-radius: 2px !important;
        margin: 0 auto 10px !important;
      }
      .ozwell-chat-header {
        padding-top: 12px !important;
        flex-direction: column !important;
        align-items: stretch !important;
      }
      .ozwell-chat-controls {
        display: flex !important;
        justify-content: flex-end !important;
        margin-top: -8px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

export const OzwellWidget: React.FC = () => {
  const { user } = useSession();
  const { pathname, navigate } = useRouter();
  const { selectedTeam, selectedTeamId, teams, activeClockEvent, refetchClock, setSelectedTeamId } =
    useTeam();

  // Keep a stable ref to mutable context so the tool handler always has fresh values
  // without needing to re-register the listener on every render.
  const ctxRef = useRef({
    user,
    pathname,
    selectedTeam,
    selectedTeamId,
    teams,
    activeClockEvent,
    refetchClock,
    navigate,
    setSelectedTeamId,
  });
  useEffect(() => {
    ctxRef.current = {
      user,
      pathname,
      selectedTeam,
      selectedTeamId,
      teams,
      activeClockEvent,
      refetchClock,
      navigate,
      setSelectedTeamId,
    };
  }, [
    user,
    pathname,
    selectedTeam,
    selectedTeamId,
    teams,
    activeClockEvent,
    refetchClock,
    navigate,
    setSelectedTeamId,
  ]);

  // ── Effect 1: inject loader script once ───────────────────────────────────
  useEffect(() => {
    const env = (import.meta as { env?: Record<string, string> }).env;
    const apiKey = env?.VITE_OZWELL_AGENT_KEY;
    if (!apiKey) {
      // Widget intentionally disabled when no key is configured.
      return;
    }

    if (document.getElementById(SCRIPT_ID)) return; // already injected

    window.OzwellChatConfig = {
      apiKey,
      debug: Boolean(env?.DEV),
    };

    injectMobileOverride();
    injectJerryButtonStyles(); // inject before script so button is styled on creation

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = LOADER_URL;
    script.async = true;
    document.body.appendChild(script);

    return () => {
      document.getElementById(SCRIPT_ID)?.remove();
      document.getElementById(MOBILE_OVERRIDE_STYLE_ID)?.remove();
      document.getElementById(JERRY_BUTTON_STYLE_ID)?.remove();
      delete window.OzwellChatConfig;
    };
  }, []); // intentionally empty — run once

  // ── Effect 2: inject Jerry button once widget is ready ────────────────────
  useEffect(() => {
    const onReady = () => {
      injectJerryButtonStyles();
      injectJerryButtonContent();
    };
    document.addEventListener('ozwell-chat-ready', onReady);
    // Widget may already be ready if this effect runs late
    if (document.getElementById('ozwell-chat-button')) onReady();
    return () => document.removeEventListener('ozwell-chat-ready', onReady);
  }, []);

  // ── Effect 3: hide "(no response)" tool-call bubbles ──────────────────────
  useEffect(() => {
    const observer = new MutationObserver(() => hideNoResponseBubbles(document.body));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    hideNoResponseBubbles(document.body);
    return () => observer.disconnect();
  }, []);

  // ── Effect 4: sync live context to widget ─────────────────────────────────
  useEffect(() => {
    if (!window.OzwellChat?.updateContext) return;
    window.OzwellChat.updateContext({
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      page: pathname,
      teamId: selectedTeamId,
      teamName: selectedTeam?.name ?? null,
      today: new Date().toLocaleDateString('en-CA'),
      // Clock status — Jerry reads this directly instead of calling get_clock_status
      clockedIn: activeClockEvent != null,
      clockedInTeamId: activeClockEvent?.teamId ?? null,
      clockedInTeamName: activeClockEvent
        ? activeClockEvent.teamId
          ? (teams.find((t) => t.id === activeClockEvent.teamId)?.name ?? null)
          : null
        : null,
      clockedInSince: activeClockEvent
        ? new Date(activeClockEvent.startTime).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })
        : null,
    });
  }, [user, pathname, selectedTeam, selectedTeamId, activeClockEvent, teams]);

  // ── Effect 5: tool call handler ───────────────────────────────────────────
  const handleToolCall = useCallback((e: Event) => {
    const { name, arguments: args, respond } = (e as CustomEvent<OzwellToolCallDetail>).detail;
    const ctx = ctxRef.current;

    void (async () => {
      try {
        switch (name) {
          // Navigation
          case 'navigate': {
            const path = String(args.path ?? '');
            if (!path.startsWith('/app/')) {
              respond({ success: false, error: 'Invalid path. Must start with /app/' });
              return;
            }
            ctx.navigate(path);
            respond({ success: true, data: { path } });
            break;
          }

          // Read context
          case 'get_current_user': {
            if (!ctx.user) {
              respond({ success: false, error: 'No user session found' });
              return;
            }
            respond({
              success: true,
              data: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
            });
            break;
          }

          case 'get_current_page': {
            respond({ success: true, data: { path: ctx.pathname } });
            break;
          }

          case 'get_current_team': {
            if (!ctx.selectedTeam) {
              respond({ success: false, error: 'No team selected' });
              return;
            }
            respond({ success: true, data: ctx.selectedTeam });
            break;
          }

          case 'get_teams': {
            respond({ success: true, data: ctx.teams });
            break;
          }

          // Clock
          case 'get_clock_sessions': {
            if (!user?.id) {
              respond({ success: false, error: 'No user session found' });
              return;
            }
            const todayStr = new Date().toLocaleDateString('en-CA');
            const startDateStr = String(args.start_date ?? todayStr);
            const endDateStr = String(args.end_date ?? startDateStr);
            // Convert local dates to epoch ms boundaries
            const startMs = new Date(`${startDateStr}T00:00:00`).getTime();
            const endMs = new Date(`${endDateStr}T23:59:59.999`).getTime();
            const result = await clockApi.getTimesheet(user.id, startMs, endMs);

            // Resolve team filter: explicit arg takes priority, then selected team
            const argTeamId = args.team_id ? String(args.team_id) : undefined;
            const argTeamName = args.team_name ? String(args.team_name).toLowerCase() : undefined;
            const resolvedByName = argTeamName
              ? ctx.teams.find((t) => t.name.toLowerCase().includes(argTeamName))
              : undefined;
            const filterTeamId = argTeamId ?? resolvedByName?.id ?? ctx.selectedTeamId;
            const filteredSessions = filterTeamId
              ? result.sessions.filter((s) => s.teamId === filterTeamId)
              : result.sessions;

            // Compute work seconds the same way TimesheetPage does (uses accumulatedTime when set)
            const now = Date.now();
            const getWorkSeconds = (s: (typeof filteredSessions)[number]): number => {
              if (!s.endTime) {
                const acc = Math.max(0, s.accumulatedTime ?? 0);
                return acc + Math.max(0, Math.floor((now - s.startTime) / 1000));
              }
              const acc = Math.max(0, s.accumulatedTime ?? 0);
              if (acc > 0) return acc;
              return Math.max(0, Math.floor((s.endTime - s.startTime) / 1000));
            };

            const totalSeconds = filteredSessions.reduce((sum, s) => sum + getWorkSeconds(s), 0);
            const sessions = filteredSessions.map((s) => ({
              id: s.id,
              date: new Date(s.startTime).toLocaleDateString([], {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              }),
              clockIn: new Date(s.startTime).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
              clockOut: s.endTime
                ? new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'still clocked in',
              duration: formatDuration(getWorkSeconds(s)),
              teamId: s.teamId ?? null,
              team: s.teamId
                ? (ctx.teams.find((t) => t.id === s.teamId)?.name ?? s.teamId)
                : 'No Team',
            }));
            respond({
              success: true,
              data: {
                startDate: startDateStr,
                endDate: endDateStr,
                teamFilter: filterTeamId
                  ? (ctx.teams.find((t) => t.id === filterTeamId)?.name ?? filterTeamId)
                  : 'all teams',
                sessions,
                totalSessions: filteredSessions.length,
                grandTotal: formatDuration(totalSeconds),
              },
            });
            break;
          }

          case 'get_clock_status': {
            if (ctx.activeClockEvent) {
              const elapsedSeconds =
                (Date.now() - new Date(ctx.activeClockEvent.startTime).getTime()) / 1000;
              respond({
                success: true,
                data: {
                  clockedIn: true,
                  since: ctx.activeClockEvent.startTime,
                  elapsed: formatDuration(elapsedSeconds),
                  eventId: ctx.activeClockEvent.id,
                  teamId: ctx.activeClockEvent.teamId ?? null,
                },
              });
            } else {
              respond({ success: true, data: { clockedIn: false } });
            }
            break;
          }

          case 'clock_in': {
            const event = await clockApi.start();
            ctx.refetchClock();
            respond({ success: true, data: event });
            break;
          }

          case 'clock_out': {
            if (!ctx.activeClockEvent) {
              respond({ success: false, error: 'You are not currently clocked in.' });
              return;
            }
            const stoppedEvent = await clockApi.stop();
            ctx.refetchClock();
            respond({ success: true, data: stoppedEvent });
            break;
          }

          case 'update_timesheet_entry': {
            const entryId = String(args.id ?? '');
            if (!entryId) {
              respond({ success: false, error: 'Missing required field: id' });
              return;
            }
            const updates: { startTime?: number; endTime?: number | null } = {};
            if (args.startTime != null)
              updates.startTime = new Date(String(args.startTime)).getTime();
            if (args.endTime != null) updates.endTime = new Date(String(args.endTime)).getTime();
            const updated = await clockApi.updateTimes(entryId, updates);
            ctx.refetchClock();
            respond({ success: true, data: updated });
            break;
          }

          case 'delete_timesheet_entry': {
            const delId = String(args.id ?? '');
            if (!delId) {
              respond({ success: false, error: 'Missing required field: id' });
              return;
            }
            await clockApi.deleteEvent(delId);
            ctx.refetchClock();
            respond({ success: true });
            break;
          }

          // Tickets
          case 'get_tickets': {
            if (!ctx.selectedTeamId) {
              respond({ success: false, error: 'No team selected' });
              return;
            }
            const tickets = await ticketApi.getTickets(ctx.selectedTeamId);
            respond({ success: true, data: tickets });
            break;
          }

          case 'create_ticket': {
            if (!ctx.selectedTeamId) {
              respond({ success: false, error: 'No team selected' });
              return;
            }
            let title = String(args.title ?? '');
            const githubUrl = String(args.github ?? '');
            const descriptionArg = args.description ? String(args.description) : undefined;

            if (!title) {
              respond({ success: false, error: 'Missing required field: title' });
              return;
            }

            // If the title IS a GitHub URL, auto-fetch the real title + body
            if (isGithubIssueUrl(title)) {
              const issue = await fetchGithubIssue(title);
              const url = title;
              title = issue?.title ?? title;
              const description = descriptionArg ?? issue?.body ?? null;
              const ticket = await createTicketFromGithub({
                teamId: ctx.selectedTeamId,
                url,
                title,
                description,
              });
              window.dispatchEvent(new Event('tickets:refetch'));
              respond({ success: true, data: ticket });
              break;
            }

            // If a separate github URL is provided, use createTicketFromGithub
            if (githubUrl && isGithubIssueUrl(githubUrl)) {
              const issue = await fetchGithubIssue(githubUrl);
              const description = descriptionArg ?? issue?.body ?? null;
              const ticket = await createTicketFromGithub({
                teamId: ctx.selectedTeamId,
                url: githubUrl,
                title,
                description,
              });
              window.dispatchEvent(new Event('tickets:refetch'));
              respond({ success: true, data: ticket });
              break;
            }

            // Plain ticket
            const ticket = await ticketApi.createTicket({
              teamId: ctx.selectedTeamId,
              title,
            });
            if (descriptionArg) {
              await ticketApi.updateTicket(ticket.id, { description: descriptionArg });
            }
            window.dispatchEvent(new Event('tickets:refetch'));
            respond({ success: true, data: ticket });
            break;
          }

          case 'update_ticket': {
            const ticketId = String(args.id ?? '');
            if (!ticketId) {
              respond({ success: false, error: 'Missing required field: id' });
              return;
            }
            const hasStatusOrPriority = args.status != null || args.priority != null;
            const hasTitleOrDescription = args.title != null || args.description != null;

            let updatedTicket;
            if (hasStatusOrPriority && !hasTitleOrDescription) {
              updatedTicket = await ticketApi.updateStatusPriority(ticketId, {
                status: args.status as string | undefined,
                priority: args.priority as string | undefined,
              });
            } else if (hasTitleOrDescription && !hasStatusOrPriority) {
              updatedTicket = await ticketApi.updateTicket(ticketId, {
                title: args.title as string | undefined,
                description: args.description as string | undefined,
              });
            } else {
              // Both: do two calls, return the final state
              if (hasTitleOrDescription) {
                await ticketApi.updateTicket(ticketId, {
                  title: args.title as string | undefined,
                  description: args.description as string | undefined,
                });
              }
              updatedTicket = await ticketApi.updateStatusPriority(ticketId, {
                status: args.status as string | undefined,
                priority: args.priority as string | undefined,
              });
            }
            window.dispatchEvent(new Event('tickets:refetch'));
            respond({ success: true, data: updatedTicket });
            break;
          }

          case 'delete_ticket': {
            const delTicketId = String(args.id ?? '');
            if (!delTicketId) {
              respond({ success: false, error: 'Missing required field: id' });
              return;
            }
            await ticketApi.deleteTicket(delTicketId);
            window.dispatchEvent(new Event('tickets:refetch'));
            respond({ success: true });
            break;
          }

          // Teams
          case 'switch_team': {
            // Try teamId first, then fall back to name match (case-insensitive).
            // Using explicit truthiness check so empty-string args don't mask the other field.
            const teamIdArg = args.teamId ? String(args.teamId) : '';
            const teamNameArg = args.name ? String(args.name) : '';

            if (!teamIdArg && !teamNameArg) {
              const available = ctx.teams.map((t) => `"${t.name}" (${t.id})`).join(', ');
              respond({
                success: false,
                error: `Provide teamId or name. Available teams: ${available}`,
              });
              return;
            }

            const matchedTeam =
              (teamIdArg ? ctx.teams.find((t) => t.id === teamIdArg) : undefined) ??
              (teamNameArg
                ? ctx.teams.find((t) => t.name.toLowerCase() === teamNameArg.toLowerCase())
                : undefined);

            if (!matchedTeam) {
              const query = teamIdArg || teamNameArg;
              const available = ctx.teams.map((t) => `"${t.name}"`).join(', ');
              respond({
                success: false,
                error: `Team "${query}" not found. Available teams: ${available}`,
              });
              return;
            }

            // Already on this team — nothing to do
            if (matchedTeam.id === ctx.selectedTeamId) {
              respond({
                success: true,
                data: { id: matchedTeam.id, name: matchedTeam.name, alreadySelected: true },
              });
              return;
            }

            ctx.setSelectedTeamId(matchedTeam.id);
            respond({ success: true, data: { id: matchedTeam.id, name: matchedTeam.name } });
            break;
          }

          case 'create_team': {
            const teamName = String(args.name ?? '');
            if (!teamName) {
              respond({ success: false, error: 'Missing required field: name' });
              return;
            }
            const newTeam = await teamApi.createTeam({
              name: teamName,
              description: args.description as string | undefined,
            });
            respond({ success: true, data: newTeam });
            break;
          }

          case 'update_team': {
            const updateTeamId = String(args.id ?? '');
            const newName = String(args.name ?? '');
            if (!updateTeamId || !newName) {
              respond({ success: false, error: 'Missing required fields: id and name' });
              return;
            }
            const renamedTeam = await teamApi.renameTeam(updateTeamId, newName);
            respond({ success: true, data: renamedTeam });
            break;
          }

          case 'delete_team': {
            const delTeamId = String(args.id ?? '');
            if (!delTeamId) {
              respond({ success: false, error: 'Missing required field: id' });
              return;
            }
            await teamApi.deleteTeam(delTeamId);
            respond({ success: true });
            break;
          }

          // Work / Timers
          case 'get_work_items': {
            const date = String(args.date ?? new Date().toLocaleDateString('en-CA'));
            const entries = await timerApi.getDay(date);
            const now = Date.now();
            let grandTotalSeconds = 0;
            const formatted = entries.map((e) => {
              const totalSeconds = e.sessions.reduce((sum, s) => {
                const end = s.endTime ?? now;
                return sum + (end - s.startTime) / 1000;
              }, 0);
              grandTotalSeconds += totalSeconds;
              return {
                ticket: e.entry.displayTitle ?? e.entry.ticketId,
                workItemId: e.entry.id,
                total: formatDuration(totalSeconds),
                sessions: e.sessions.map((s) => ({
                  id: s.id,
                  start: new Date(s.startTime).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                  end: s.endTime
                    ? new Date(s.endTime).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'running',
                  duration: formatDuration(((s.endTime ?? now) - s.startTime) / 1000),
                })),
              };
            });
            respond({
              success: true,
              data: { date, grandTotal: formatDuration(grandTotalSeconds), items: formatted },
            });
            break;
          }

          case 'create_work_item': {
            const ticketId = String(args.ticketId ?? '');
            if (!ticketId) {
              respond({ success: false, error: 'Missing required field: ticketId' });
              return;
            }
            const date = String(args.date ?? new Date().toLocaleDateString('en-CA'));
            const entry = await timerApi.createEntry({
              ticketId,
              date,
              note: args.note as string | undefined,
            });
            respond({ success: true, data: entry });
            break;
          }

          case 'start_work_timer': {
            const entryId = String(args.workItemId ?? '');
            if (!entryId) {
              respond({ success: false, error: 'Missing required field: workItemId' });
              return;
            }
            const result = await timerApi.startSession(entryId);
            window.dispatchEvent(new Event('work:refetch'));
            respond({ success: true, data: result });
            break;
          }

          case 'stop_work_timer': {
            const sessionId = String(args.sessionId ?? '');
            if (!sessionId) {
              respond({ success: false, error: 'Missing required field: sessionId' });
              return;
            }
            const stopped = await timerApi.stopSession(sessionId);
            window.dispatchEvent(new Event('work:refetch'));
            respond({ success: true, data: stopped });
            break;
          }

          case 'get_running_timer': {
            const running = await timerApi.getRunning();
            respond({ success: true, data: running ?? null });
            break;
          }

          /**
           * Start a timer for an existing ticket.
           *
           * Rules enforced here (per product requirements):
           *   1. Never creates a ticket — use create_ticket first if needed.
           *   2. Ticket must belong to the currently selected team.
           *   3. User must be clocked in to the currently selected team.
           *   4. Reuses an existing work item for today if one exists (idempotent).
           */
          case 'start_ticket_timer': {
            const teamId = ctx.selectedTeamId;
            const teamName = ctx.selectedTeam?.name ?? 'the selected team';

            if (!teamId) {
              respond({
                success: false,
                error: 'No team selected. Use switch_team to select a team first.',
              });
              return;
            }

            // ── 1. Resolve ticketId (lookup only — never create) ──────────────
            let ticketId = String(args.ticketId ?? '');
            const ticketTitle = String(args.title ?? '');

            if (!ticketId && !ticketTitle) {
              respond({
                success: false,
                error: 'Provide ticketId or title to identify the ticket.',
              });
              return;
            }

            // Fetch all tickets for the current team
            const teamTickets = await ticketApi.getTickets(teamId);

            if (ticketId) {
              // Validate the provided ID belongs to the current team
              const belongs = teamTickets.some((t) => t.id === ticketId);
              if (!belongs) {
                respond({
                  success: false,
                  error:
                    `Ticket ${ticketId} does not belong to "${teamName}". ` +
                    `Use switch_team to switch to the correct team, or get_tickets to list tickets for this team.`,
                });
                return;
              }
            } else {
              // Find by title (case-insensitive)
              const match = teamTickets.find(
                (t) => t.title.toLowerCase() === ticketTitle.toLowerCase(),
              );
              if (!match) {
                respond({
                  success: false,
                  error:
                    `No ticket titled "${ticketTitle}" found in "${teamName}". ` +
                    `Use get_tickets to list available tickets, or create_ticket if you want to create a new one.`,
                });
                return;
              }
              ticketId = match.id;
            }

            // ── 2. Verify user is clocked in to this team ─────────────────────
            if (!ctx.activeClockEvent) {
              respond({
                success: false,
                error: `You are not clocked in. Use clock_in to clock in to "${teamName}" first.`,
              });
              return;
            }
            if (ctx.activeClockEvent.teamId && ctx.activeClockEvent.teamId !== teamId) {
              const clockedTeam = ctx.teams.find((t) => t.id === ctx.activeClockEvent?.teamId);
              respond({
                success: false,
                error:
                  `You are clocked in to "${clockedTeam?.name ?? ctx.activeClockEvent.teamId}" but the ticket belongs to "${teamName}". ` +
                  `Use switch_team to switch to the correct team, then clock_out and clock_in again.`,
              });
              return;
            }

            // ── 3. Get or create a work item for today ────────────────────────
            const today = new Date().toLocaleDateString('en-CA');
            const todayEntries = await timerApi.getDay(today);
            const existingDayEntry = todayEntries.find((de) => de.entry.ticketId === ticketId);
            const entry = existingDayEntry
              ? existingDayEntry.entry
              : await timerApi.createEntry({ ticketId, date: today });

            // ── 4. Start the timer ────────────────────────────────────────────
            const session = await timerApi.startSession(entry.id);
            window.dispatchEvent(new Event('work:refetch'));
            respond({ success: true, data: { workItem: entry, session } });
            break;
          }

          default:
            respond({ success: false, error: `Unknown tool: ${name}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        respond({ success: false, error: message });
      }
    })();
  }, []); // stable — reads ctx via ref

  useEffect(() => {
    document.addEventListener('ozwell-tool-call', handleToolCall);
    return () => document.removeEventListener('ozwell-tool-call', handleToolCall);
  }, [handleToolCall]);

  return null;
};
