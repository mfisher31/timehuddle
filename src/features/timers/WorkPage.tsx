/**
 * WorkPage — Week strip + Day view timesheet.
 *
 * Features:
 *   • 7-day week strip (Mon–Sun) with local-day totals
 *   • Day view: list of work item rows with start/stop controls
 *   • "+" action: create a new work item for the selected day
 *   • Copy from previous day
 *   • Soft-deleted ticket rows render as "Unassociated Timer"
 */
import {
  faCheck,
  faChevronLeft,
  faChevronRight,
  faCopy,
  faEllipsisVertical,
  faPause,
  faPlay,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '@mieweb/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  clockApi,
  timerApi,
  ticketApi,
  type DayEntry,
  type Timer,
  type Ticket,
} from '../../lib/api';
import { useTeam } from '../../lib/TeamContext';
import { useRefresh } from '../../lib/RefreshContext';
import { formatDuration } from '../../lib/timeUtils';
import { useClockToggle } from '../../lib/useClockToggle';
import { AppPage } from '../../ui/AppPage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA'); // "YYYY-MM-DD" in local time
}

/** Format total seconds as "H:MM" for the duration input field. */
function secondsToHHMM(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Parse "H:MM" or "HH:MM" to seconds. Returns null if invalid. */
function hhmmToSeconds(value: string): number | null {
  const match = value.trim().match(/^(\d+):([0-5]\d)$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60;
}

function getWeekStart(d: Date): Date {
  const dow = d.getDay(); // 0 = Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dow + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function fmtShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

function runningSeconds(session: Timer, now: number): number {
  if (session.endTime !== null) return session.durationSeconds ?? 0;
  return Math.max(0, Math.floor((now - session.startTime) / 1000));
}

function entryTotalSeconds(sessions: Timer[], now: number): number {
  return sessions.reduce((sum, s) => sum + runningSeconds(s, now), 0);
}

// ─── WorkPage ─────────────────────────────────────────────────────────────────

export const WorkPage: React.FC = () => {
  const { teams, teamsReady, currentTime, selectedTeamId, activeClockEvent } = useTeam();
  const { isClockedIn, clockIn, clockInLoading } = useClockToggle();
  const previousClockedInRef = useRef(isClockedIn);
  // When clock-in is immediately followed by startTimerForEntry, suppress the
  // auto-fetchDay triggered by the isClockedIn change to avoid a race where
  // the fetch response (stale — before the session started) overwrites the
  // optimistic update made by startTimerForEntry.
  const skipNextClockInFetchRef = useRef(false);

  // Selected day (local YYYY-MM-DD)
  const [selectedDate, setSelectedDate] = useState<string>(toLocalDateStr(new Date()));

  // Whether the selected day is today (updates reactively at midnight via currentTime)
  const isToday = selectedDate === toLocalDateStr(new Date(currentTime));
  const isFuture = selectedDate > toLocalDateStr(new Date(currentTime));
  const isOnBreak = isClockedIn && !!activeClockEvent?.isPaused;

  // Week days derived from selectedDate
  const weekDays = useMemo(() => {
    const base = new Date(selectedDate + 'T00:00:00');
    const monday = getWeekStart(base);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [selectedDate]);

  // Day totals from API
  const [weekTotals, setWeekTotals] = useState<Record<string, number>>({});
  const [weekTotalsLoading, setWeekTotalsLoading] = useState(false);

  // Day entries
  const [dayEntries, setDayEntries] = useState<DayEntry[]>([]);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);

  const [showNewEntry, setShowNewEntry] = useState(false);
  const [newEntryTicketId, setNewEntryTicketId] = useState('');
  const [newEntryNote, setNewEntryNote] = useState('');
  const [newEntryLoading, setNewEntryLoading] = useState(false);

  // Clock-in confirmation before starting timer
  const [showClockInPrompt, setShowClockInPrompt] = useState(false);
  const [pendingStartEntryId, setPendingStartEntryId] = useState<string | null>(null);
  const [clockInPromptError, setClockInPromptError] = useState<string | null>(null);

  // Copy state
  const [copyLoading, setCopyLoading] = useState(false);
  const [copyDone, setCopyDone] = useState(false);

  // All tickets across the user's teams (for labels and pickers)
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);

  // Edit modal state
  const [editEntry, setEditEntry] = useState<DayEntry | null>(null);
  const [editNote, setEditNote] = useState('');
  const [editDuration, setEditDuration] = useState('');
  const [editTicketId, setEditTicketId] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  // ── Fetch tickets for all teams (for both pickers) ──

  useEffect(() => {
    if (teams.length === 0) {
      setAllTickets([]);
      return;
    }

    let cancelled = false;

    const loadTickets = async () => {
      try {
        const ticketLists = await Promise.all(teams.map((team) => ticketApi.getTickets(team.id)));
        if (cancelled) return;

        const byId = new Map<string, Ticket>();
        for (const tickets of ticketLists) {
          for (const ticket of tickets) {
            byId.set(ticket.id, ticket);
          }
        }

        setAllTickets(Array.from(byId.values()));
      } catch {
        if (!cancelled) setAllTickets([]);
      }
    };

    void loadTickets();

    return () => {
      cancelled = true;
    };
  }, [teams]);

  // ── Fetch week totals ──

  const fetchWeekTotals = useCallback(async () => {
    setWeekTotalsLoading(true);
    try {
      const days = await timerApi.getWeek(toLocalDateStr(weekDays[0]));
      const map: Record<string, number> = {};
      for (const d of days) map[d.date] = d.totalSeconds;
      setWeekTotals(map);
    } catch {
      // keep previous
    } finally {
      setWeekTotalsLoading(false);
    }
  }, [weekDays]);

  useEffect(() => {
    void fetchWeekTotals();
  }, [fetchWeekTotals]);

  // ── Fetch day entries ──

  const fetchDay = useCallback(async () => {
    try {
      const entries = await timerApi.getDay(selectedDate);
      setDayEntries(entries);
    } catch {
      // keep previous
    }
  }, [selectedDate]);

  useEffect(() => {
    void fetchDay();
  }, [fetchDay]);

  // Pull-to-refresh: combine both fetches
  useRefresh(
    useCallback(async () => {
      await Promise.all([fetchDay(), fetchWeekTotals()]);
    }, [fetchDay, fetchWeekTotals]),
  );

  useEffect(() => {
    const handler = () => {
      void fetchDay();
      void fetchWeekTotals();
    };
    window.addEventListener('work:refetch', handler);
    return () => window.removeEventListener('work:refetch', handler);
  }, [fetchDay, fetchWeekTotals]);

  useEffect(() => {
    const previousClockedIn = previousClockedInRef.current;
    previousClockedInRef.current = isClockedIn;

    if (previousClockedIn === isClockedIn || !isToday) return;

    if (skipNextClockInFetchRef.current) {
      skipNextClockInFetchRef.current = false;
      return;
    }

    void fetchDay();
    void fetchWeekTotals();
  }, [fetchDay, fetchWeekTotals, isClockedIn, isToday]);

  // ── Real-time clock updates ──

  useEffect(() => {
    if (teams.length === 0) return;

    const ws = clockApi.openLiveStream();

    ws.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      // On any clock event update (timer start/stop), refetch current day and week totals
      if (data.type === 'update') {
        void fetchDay();
        void fetchWeekTotals();
      }
    };

    return () => ws.close();
  }, [teams, fetchDay, fetchWeekTotals]);

  // ── Real-time timer updates ──

  useEffect(() => {
    console.log('[WorkPage] Opening timer WebSocket connection');
    const ws = timerApi.openLiveStream();

    ws.onmessage = (event: MessageEvent) => {
      console.log('[WorkPage] Timer WebSocket message received:', event.data);
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        console.log('[WorkPage] Timer WebSocket connected successfully');
        return;
      }

      // On timer start/stop/delete, refetch current day and week totals
      if (data.type === 'update') {
        console.log('[WorkPage] Refreshing timer data due to update event');
        void fetchDay();
        void fetchWeekTotals();
      }
    };

    return () => {
      console.log('[WorkPage] Closing timer WebSocket connection');
      ws.close();
    };
  }, [fetchDay, fetchWeekTotals]);

  // ── Handlers ──

  const startTimerForEntry = useCallback(
    async (entryId: string) => {
      try {
        const { session, closedSessionId } = await timerApi.startSession(entryId, Date.now());
        // Optimistic update
        setDayEntries((prev) =>
          prev.map((de) => {
            if (de.entry.id !== entryId && !closedSessionId) return de;
            return {
              ...de,
              sessions: de.sessions
                .map((s) =>
                  s.id === closedSessionId
                    ? {
                        ...s,
                        endTime: session.startTime,
                        durationSeconds: Math.floor((session.startTime - s.startTime) / 1000),
                      }
                    : s,
                )
                .concat(de.entry.id === entryId ? [session] : []),
            };
          }),
        );
      } catch {
        void fetchDay();
      }
    },
    [fetchDay],
  );

  const handleStart = useCallback(
    async (entryId: string) => {
      if (!isClockedIn) {
        setPendingStartEntryId(entryId);
        setClockInPromptError(null);
        setShowClockInPrompt(true);
        return;
      }

      await startTimerForEntry(entryId);
    },
    [isClockedIn, startTimerForEntry],
  );

  const handleClockInAndStart = useCallback(async () => {
    if (!pendingStartEntryId) return;

    if (!selectedTeamId) {
      setClockInPromptError('Select a team before clocking in.');
      return;
    }

    setClockInPromptError(null);
    skipNextClockInFetchRef.current = true;
    await clockIn();

    const entryId = pendingStartEntryId;
    setShowClockInPrompt(false);
    setPendingStartEntryId(null);

    await startTimerForEntry(entryId);
  }, [pendingStartEntryId, selectedTeamId, clockIn, startTimerForEntry]);

  const handleStop = useCallback(
    async (sessionId: string) => {
      try {
        const closed = await timerApi.stopSession(sessionId, Date.now());
        setDayEntries((prev) =>
          prev.map((de) => ({
            ...de,
            sessions: de.sessions.map((s) => (s.id === sessionId ? closed : s)),
          })),
        );
        void fetchWeekTotals();
      } catch {
        void fetchDay();
      }
    },
    [fetchDay, fetchWeekTotals],
  );

  const handleCreateEntry = useCallback(async () => {
    if (!newEntryTicketId) return;
    setNewEntryLoading(true);
    try {
      await timerApi.createEntry({
        ticketId: newEntryTicketId,
        date: selectedDate,
        note: newEntryNote.trim() ? newEntryNote.trim() : undefined,
      });
      setShowNewEntry(false);
      setNewEntryTicketId('');
      setNewEntryNote('');
      void fetchDay();
    } catch {
      // ignore duplicates (entry already exists)
      setShowNewEntry(false);
    } finally {
      setNewEntryLoading(false);
    }
  }, [newEntryTicketId, newEntryNote, selectedDate, fetchDay]);

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      setDeletingEntryId(entryId);
      try {
        await timerApi.deleteEntry(entryId);
        setDayEntries((prev) => prev.filter((de) => de.entry.id !== entryId));
        void fetchWeekTotals();
      } catch {
        void fetchDay();
      } finally {
        setDeletingEntryId(null);
      }
    },
    [fetchDay, fetchWeekTotals],
  );

  const handlePrevWeek = useCallback(() => {
    const base = new Date(selectedDate + 'T00:00:00');
    setSelectedDate(toLocalDateStr(addDays(base, -7)));
  }, [selectedDate]);

  const handleNextWeek = useCallback(() => {
    const base = new Date(selectedDate + 'T00:00:00');
    setSelectedDate(toLocalDateStr(addDays(base, 7)));
  }, [selectedDate]);

  const handleGoToToday = useCallback(() => {
    setSelectedDate(toLocalDateStr(new Date()));
  }, []);

  const handleOpenEdit = useCallback((de: DayEntry) => {
    const total = entryTotalSeconds(de.sessions, Date.now());
    setEditEntry(de);
    setEditNote(de.entry.note ?? '');
    setEditDuration(secondsToHHMM(total));
    setEditTicketId(de.entry.ticketId);
    setEditError(null);
  }, []);

  const handleUpdateEntry = useCallback(async () => {
    if (!editEntry) return;
    const parsedSeconds = hhmmToSeconds(editDuration);
    const isRunning = !!editEntry.sessions.find((s) => s.endTime === null);
    const ticketChanged = editTicketId !== editEntry.entry.ticketId;
    setEditLoading(true);
    setEditError(null);
    try {
      const updated = await timerApi.updateEntry(editEntry.entry.id, {
        note: editNote || null,
        ...(!isRunning && parsedSeconds !== null ? { durationSeconds: parsedSeconds } : {}),
        ...(ticketChanged ? { ticketId: editTicketId } : {}),
      });
      setDayEntries((prev) =>
        prev.map((de) => (de.entry.id === updated.id ? { ...de, entry: updated } : de)),
      );
      if (!isRunning && parsedSeconds !== null) void fetchDay();
      setEditEntry(null);
    } catch (error) {
      if (error instanceof ApiError) {
        setEditError(error.message);
      } else {
        setEditError('Unable to update work item. Please try again.');
      }
    } finally {
      setEditLoading(false);
    }
  }, [editEntry, editNote, editDuration, editTicketId, fetchDay]);

  const handleCopyPrevious = useCallback(async () => {
    setCopyLoading(true);
    try {
      await timerApi.copyPrevious(selectedDate);
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 2000);
      void fetchDay();
    } catch {
      // ignore
    } finally {
      setCopyLoading(false);
    }
  }, [selectedDate, fetchDay]);

  // ── Derived ──

  const ticketOptions = useMemo(
    () =>
      allTickets
        .filter((t) => t.status !== 'deleted')
        .map((t) => ({ value: t.id, label: t.title })),
    [allTickets],
  );

  const ticketsById = useMemo(() => {
    const map = new Map<string, Ticket>();
    for (const ticket of allTickets) map.set(ticket.id, ticket);
    return map;
  }, [allTickets]);

  const teamNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of teams) map.set(team.id, team.name);
    return map;
  }, [teams]);

  const getWorkItemLabel = useCallback(
    (entry: DayEntry['entry']) => {
      const ticket = ticketsById.get(entry.ticketId);
      const baseTitle = entry.displayTitle || ticket?.title || '(untitled)';
      const teamName = ticket ? teamNamesById.get(ticket.teamId) : undefined;
      return teamName ? `${baseTitle} - ${teamName}` : baseTitle;
    },
    [ticketsById, teamNamesById],
  );

  const selectedDayLabel = useMemo(
    () =>
      new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    [selectedDate],
  );

  const weekRangeLabel = useMemo(() => {
    const formatWeekDay = (d: Date) =>
      d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });

    return `${formatWeekDay(weekDays[0])} - ${formatWeekDay(weekDays[6])}`;
  }, [weekDays]);

  if (!teamsReady) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner size="lg" label="Loading…" />
      </div>
    );
  }

  return (
    <AppPage fullWidth>
      {/* ── Page Header: week nav + today + week range ── */}
      <div className="flex items-center justify-between gap-3">
        <Text weight="semibold" className="truncate">
          {weekRangeLabel}
        </Text>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePrevWeek}
            aria-label="Previous week"
            className="shrink-0"
          >
            <FontAwesomeIcon icon={faChevronLeft} className="text-xs" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleGoToToday} aria-label="Go to today">
            Today
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNextWeek}
            aria-label="Next week"
            className="shrink-0"
          >
            <FontAwesomeIcon icon={faChevronRight} className="text-xs" />
          </Button>
        </div>
      </div>

      {/* ── Week Strip + Add Button ── */}
      <div className="flex flex-col gap-2 sm:gap-0">
        {/* On small screens: full-width add button above the strip */}
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowNewEntry(true)}
          aria-label="Add work item"
          className="w-full sm:hidden min-h-12"
        >
          + Add Work Item
        </Button>

        <Card padding="sm">
          <CardContent>
            <div className="flex items-center gap-1">
              {/* On wider screens: + button sits left of the day selectors */}
              <Button
                variant="primary"
                size="icon"
                onClick={() => setShowNewEntry(true)}
                aria-label="Add work item"
                className="hidden sm:flex shrink-0 mr-1"
              >
                +
              </Button>
              <div className="grid grid-cols-7 gap-1 flex-1" role="tablist" aria-label="Select day">
                {weekDays.map((day) => {
                  const dateStr = toLocalDateStr(day);
                  const total = weekTotals[dateStr] ?? 0;
                  const isSelected = dateStr === selectedDate;
                  const isToday = dateStr === toLocalDateStr(new Date());
                  return (
                    <button
                      key={dateStr}
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => setSelectedDate(dateStr)}
                      className={`flex flex-col items-center rounded-lg p-2 text-xs transition-colors ${
                        isSelected
                          ? 'bg-primary text-primary-foreground'
                          : isToday
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-muted'
                      }`}
                    >
                      <span className="font-medium">{fmtShortDate(day)}</span>
                      <span className={`mt-0.5 font-mono ${total > 0 ? '' : 'opacity-40'}`}>
                        {weekTotalsLoading ? '…' : formatDuration(total)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Day Header ── */}
      <div className="flex items-center">
        <Text weight="semibold">{selectedDayLabel}</Text>
        {isOnBreak && (
          <Badge variant="warning" size="sm" className="ml-2">
            On Break
          </Badge>
        )}
      </div>

      {/* ── New Entry Modal ── */}
      <Modal
        open={showNewEntry}
        onOpenChange={(o) => {
          setShowNewEntry(o);
          if (!o) {
            setNewEntryTicketId('');
            setNewEntryNote('');
          }
        }}
        aria-labelledby="new-entry-title"
      >
        <ModalHeader>
          <Text weight="semibold" id="new-entry-title">
            Add work item for{' '}
            {new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </Text>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-4">
          <Select
            label="Ticket"
            searchable
            searchPlaceholder="Search tickets…"
            options={ticketOptions}
            value={newEntryTicketId}
            onValueChange={(v) => setNewEntryTicketId(v)}
            placeholder="Select a ticket…"
          />
          <Input
            label="Note (optional)"
            value={newEntryNote}
            onChange={(e) => setNewEntryNote(e.target.value)}
            placeholder="Note (optional)"
          />
        </ModalBody>
        <ModalFooter>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={handleCreateEntry}
              isLoading={newEntryLoading}
              disabled={!newEntryTicketId}
            >
              Add work item
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowNewEntry(false);
                setNewEntryTicketId('');
                setNewEntryNote('');
              }}
            >
              Cancel
            </Button>
          </div>
        </ModalFooter>
      </Modal>

      {/* ── Clock-In Prompt Modal ── */}
      <Modal
        open={showClockInPrompt}
        onOpenChange={(open) => {
          setShowClockInPrompt(open);
          if (!open) {
            setPendingStartEntryId(null);
            setClockInPromptError(null);
          }
        }}
        aria-labelledby="clock-in-prompt-title"
      >
        <ModalHeader>
          <Text weight="semibold" id="clock-in-prompt-title">
            Clock In Required
          </Text>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-2">
          <Text size="sm">
            You must be clocked in before starting a timer. Do you want to clock in now?
          </Text>
          {clockInPromptError && (
            <Text size="xs" className="text-danger">
              {clockInPromptError}
            </Text>
          )}
        </ModalBody>
        <ModalFooter>
          <div className="flex gap-2">
            <Button variant="primary" onClick={handleClockInAndStart} isLoading={clockInLoading}>
              Clock In Now
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowClockInPrompt(false);
                setPendingStartEntryId(null);
                setClockInPromptError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </ModalFooter>
      </Modal>

      {/* ── Day View ── */}
      {dayEntries.length === 0 ? (
        <div className="py-10 text-center">
          <Text variant="muted" size="sm">
            No timers for this day. Create one with "+".
          </Text>
        </div>
      ) : (
        <Card padding="none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Work Item</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dayEntries.map((de) => {
                const title = getWorkItemLabel(de.entry);
                const total = entryTotalSeconds(de.sessions, currentTime);
                const runningSess = de.sessions.find((s) => s.endTime === null);
                const isRunning = !!runningSess;
                const controlsDisabled = (!isRunning && !isToday) || isOnBreak;
                const disabledReason = isOnBreak
                  ? 'Timers are paused while you are on break.'
                  : !isRunning && !isToday
                    ? 'Timers can only run on the current day — editing this entry is still available.'
                    : undefined;

                return (
                  <TableRow key={de.entry.id}>
                    <TableCell className="py-2 pr-0">
                      <span
                        title={disabledReason}
                        style={{ cursor: controlsDisabled ? 'not-allowed' : undefined }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            isRunning && runningSess
                              ? handleStop(runningSess.id)
                              : handleStart(de.entry.id)
                          }
                          disabled={controlsDisabled}
                          style={controlsDisabled ? { pointerEvents: 'none' } : undefined}
                          className={`rounded-full ${
                            isRunning
                              ? 'bg-amber-100 text-amber-600 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400'
                              : 'bg-green-100 text-green-600 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-400'
                          }`}
                          aria-label={isRunning ? 'Stop timer' : 'Start timer'}
                        >
                          <FontAwesomeIcon
                            icon={isRunning ? faPause : faPlay}
                            className="text-xs"
                          />
                        </Button>
                      </span>
                    </TableCell>

                    <TableCell className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <Text size="sm" weight="medium" truncate>
                            {title}
                          </Text>
                          {de.entry.note?.trim() && (
                            <Text size="xs" variant="muted" truncate>
                              {de.entry.note.trim()}
                            </Text>
                          )}
                        </div>
                        {isRunning && (
                          <Badge variant="success" size="sm">
                            <FontAwesomeIcon
                              icon={faSpinner}
                              className="mr-1 animate-spin text-[10px]"
                            />
                            Running
                          </Badge>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="py-2 text-right font-mono">
                      <Text size="sm" variant={total > 0 ? 'default' : 'muted'}>
                        {formatDuration(total)}
                      </Text>
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleOpenEdit(de)}
                        aria-label="Edit work item"
                        disabled={deletingEntryId === de.entry.id}
                      >
                        <FontAwesomeIcon icon={faEllipsisVertical} className="text-sm" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {(isToday || isFuture) && dayEntries.length === 0 && (
        <div className="flex justify-start">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyPrevious}
            isLoading={copyLoading}
            aria-label="Copy entries from previous day"
          >
            <FontAwesomeIcon icon={copyDone ? faCheck : faCopy} className="mr-1" />
            {copyDone
              ? 'Copied entries from most recent timesheet!'
              : 'Copy entries from most recent timesheet'}
          </Button>
        </div>
      )}

      {/* ── Edit Modal ── */}
      {editEntry &&
        (() => {
          const isRunning = !!editEntry.sessions.find((s) => s.endTime === null);
          return (
            <Modal
              open
              onOpenChange={(o) => {
                if (!o) setEditEntry(null);
              }}
              aria-labelledby="edit-entry-title"
            >
              <ModalHeader>
                <Text weight="semibold" id="edit-entry-title">
                  Edit work item for{' '}
                  {new Date(editEntry.entry.date + 'T00:00:00').toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </Text>
              </ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <Select
                  label="Ticket"
                  searchable
                  searchPlaceholder="Search tickets…"
                  options={allTickets
                    .filter((t) => t.status !== 'deleted')
                    .map((t) => ({ value: t.id, label: t.title }))}
                  value={editTicketId}
                  onValueChange={(v) => setEditTicketId(v)}
                  placeholder="Select a ticket…"
                />
                <Input
                  label="Note (optional)"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="Note (optional)"
                />
                <Input
                  label="Duration"
                  value={editDuration}
                  onChange={(e) => setEditDuration(e.target.value)}
                  placeholder="H:MM"
                  disabled={isRunning}
                  aria-describedby={isRunning ? 'duration-running-hint' : undefined}
                />
                {isRunning && (
                  <Text size="xs" variant="muted" id="duration-running-hint">
                    Duration cannot be edited while the timer is running.
                  </Text>
                )}
                {editError && (
                  <Text size="xs" className="text-danger">
                    {editError}
                  </Text>
                )}
              </ModalBody>
              <ModalFooter className="flex items-center justify-between">
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={handleUpdateEntry}
                    isLoading={editLoading}
                    disabled={!isRunning && hhmmToSeconds(editDuration) === null}
                  >
                    Update
                  </Button>
                  <Button variant="ghost" onClick={() => setEditEntry(null)}>
                    Cancel
                  </Button>
                </div>
                <Button
                  variant="danger"
                  onClick={() => {
                    void handleDeleteEntry(editEntry.entry.id);
                    setEditEntry(null);
                  }}
                  aria-label="Delete work item"
                >
                  Delete
                </Button>
              </ModalFooter>
            </Modal>
          );
        })()}
    </AppPage>
  );
};
