/**
 * TimesheetPage — Clock event history with date range filter.
 *
 * Features:
 *   • Date range presets (Today, Yesterday, 7d, This Week, 14d, Custom)
 *   • Session list with date, times, duration, team name, tickets
 *   • Summary stats (total hours, sessions, avg, working days)
 */
import { faCalendar, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '@mieweb/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useTeam } from '../../lib/TeamContext';
import { formatDuration } from '../../lib/timeUtils';
import { ApiError, clockApi, type ClockEvent } from '../../lib/api';
import { AppPage } from '../../ui/AppPage';
import { useSession } from '../../lib/useSession';
import { useRefresh } from '../../lib/RefreshContext';
import { AttachmentsPanel } from './AttachmentsPanel';
import { TimesheetRow } from './TimesheetRow';
import {
  fromLocalDateTimeInputValue,
  getDateRange,
  PRESETS,
  toLocalDateTimeInputValue,
  type Preset,
} from './timesheetUtils';

interface TimesheetData {
  sessions: ClockEvent[];
  summary: {
    totalSeconds: number;
    totalBreakSeconds: number;
    totalSessions: number;
    completedSessions: number;
    averageSessionSeconds: number;
    workingDays: number;
  };
}

interface EditableBreak {
  id: string;
  start: string;
  end: string;
}

function getSessionWorkSeconds(session: ClockEvent, now: number): number {
  if (session.endTime === null) {
    if (typeof session.workSeconds === 'number') return Math.max(0, session.workSeconds);
    const accumulated = Math.max(0, session.accumulatedTime ?? 0);
    if (session.isPaused) return accumulated;
    return accumulated + Math.max(0, Math.floor((now - session.startTime) / 1000));
  }

  const accumulated = Math.max(0, session.accumulatedTime ?? 0);
  if (accumulated > 0) return accumulated;
  return Math.max(0, Math.floor((session.endTime - session.startTime) / 1000));
}

function getSessionBreakSeconds(session: ClockEvent, now: number): number {
  const breaks = Array.isArray(session.breaks) ? session.breaks : [];
  return breaks.reduce((sum, brk) => {
    if (typeof brk.startTime !== 'number') return sum;
    const end = typeof brk.endTime === 'number' ? brk.endTime : now;
    if (end <= brk.startTime) return sum;
    return sum + Math.max(0, Math.floor((end - brk.startTime) / 1000));
  }, 0);
}

export const TimesheetPage: React.FC = () => {
  const { user } = useSession();
  const { teamsReady, teams, currentTime } = useTeam();

  const [preset, setPreset] = useState<Preset>('week');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TimesheetData | null>(null);
  const [activeSession, setActiveSession] = useState<ClockEvent | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editBreaks, setEditBreaks] = useState<EditableBreak[]>([]);
  const [sessionSaveLoading, setSessionSaveLoading] = useState(false);
  const [sessionDeleteLoading, setSessionDeleteLoading] = useState(false);
  const [sessionSaveError, setSessionSaveError] = useState<string | null>(null);

  // Add entry modal state
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [newClockIn, setNewClockIn] = useState('');
  const [newClockOut, setNewClockOut] = useState('');
  const [addEntryLoading, setAddEntryLoading] = useState(false);
  const [addEntryError, setAddEntryError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!user?.id) return;
    let startMs: number;
    let endMs: number;

    if (preset === 'custom') {
      if (!customStart || !customEnd) return;
      startMs = new Date(`${customStart}T00:00:00`).getTime();
      endMs = new Date(`${customEnd}T23:59:59.999`).getTime();
    } else {
      const [s, e] = getDateRange(preset);
      startMs = s.getTime();
      endMs = e.getTime();
    }

    setLoading(true);
    setError(null);
    try {
      const result = await clockApi.getTimesheet(user?.id ?? '', startMs, endMs);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load timesheet');
    } finally {
      setLoading(false);
    }
  }, [user?.id, preset, customStart, customEnd]);

  useEffect(() => {
    void fetchData();
  }, [preset]);

  // Pull-to-refresh
  useRefresh(fetchData);

  const openSessionDialog = useCallback((session: ClockEvent) => {
    setActiveSession(session);
    setEditClockIn(toLocalDateTimeInputValue(session.originalStartTime ?? session.startTime));
    setEditClockOut(session.endTime ? toLocalDateTimeInputValue(session.endTime) : '');
    const nextBreaks = (Array.isArray(session.breaks) ? session.breaks : [])
      .filter((brk) => typeof brk.startTime === 'number')
      .sort((a, b) => a.startTime - b.startTime)
      .map((brk, idx) => ({
        id: `${session.id}-break-${idx}`,
        start: toLocalDateTimeInputValue(brk.startTime),
        end: typeof brk.endTime === 'number' ? toLocalDateTimeInputValue(brk.endTime) : '',
      }));
    setEditBreaks(nextBreaks);
    setSessionSaveError(null);
    setSessionDialogOpen(true);
  }, []);

  const handleSaveSession = useCallback(async () => {
    if (!activeSession) return;

    const parsedStart = fromLocalDateTimeInputValue(editClockIn);
    if (parsedStart === null) {
      setSessionSaveError('Enter a valid clock-in date and time.');
      return;
    }

    const now = Date.now();
    if (parsedStart > now) {
      setSessionSaveError('Clock-in time cannot be in the future.');
      return;
    }

    let parsedEnd: number | null = null;
    if (editClockOut.trim()) {
      parsedEnd = fromLocalDateTimeInputValue(editClockOut);
      if (parsedEnd === null) {
        setSessionSaveError('Enter a valid clock-out date and time, or leave it blank.');
        return;
      }
      if (parsedEnd > now) {
        setSessionSaveError('Clock-out time cannot be in the future.');
        return;
      }
    }

    const parsedBreaks: Array<{ startTime: number; endTime: number | null }> = [];
    for (const brk of editBreaks) {
      const startInput = brk.start.trim();
      const endInput = brk.end.trim();

      if (!startInput && !endInput) continue;
      if (!startInput) {
        setSessionSaveError('Each break must include a start time.');
        return;
      }

      const breakStart = fromLocalDateTimeInputValue(startInput);
      if (breakStart === null) {
        setSessionSaveError('Enter a valid break start time.');
        return;
      }

      if (breakStart < parsedStart) {
        setSessionSaveError('Break start cannot be earlier than clock-in.');
        return;
      }

      if (parsedEnd !== null && breakStart >= parsedEnd) {
        setSessionSaveError('Break start must be before clock-out.');
        return;
      }

      let breakEnd: number | null = null;
      if (endInput) {
        breakEnd = fromLocalDateTimeInputValue(endInput);
        if (breakEnd === null) {
          setSessionSaveError('Enter a valid break end time.');
          return;
        }
        if (breakEnd <= breakStart) {
          setSessionSaveError('Break end must be later than break start.');
          return;
        }
        if (parsedEnd !== null && breakEnd > parsedEnd) {
          setSessionSaveError('Break end cannot be later than clock-out.');
          return;
        }
      } else if (parsedEnd !== null) {
        setSessionSaveError('Completed sessions require a break end time.');
        return;
      }

      parsedBreaks.push({ startTime: breakStart, endTime: breakEnd });
    }

    setSessionSaveLoading(true);
    setSessionSaveError(null);
    try {
      await clockApi.updateTimes(activeSession.id, {
        startTime: parsedStart,
        endTime: parsedEnd,
        breaks: parsedBreaks,
      });
      setSessionDialogOpen(false);
      setActiveSession(null);
      setEditBreaks([]);
      await fetchData();
    } catch (e) {
      if (e instanceof ApiError) {
        setSessionSaveError(e.message);
      } else {
        setSessionSaveError('Unable to update session times.');
      }
    } finally {
      setSessionSaveLoading(false);
    }
  }, [activeSession, editBreaks, editClockIn, editClockOut, fetchData]);

  const handleDeleteSession = useCallback(async () => {
    if (!activeSession) return;

    setSessionDeleteLoading(true);
    setSessionSaveError(null);
    try {
      await clockApi.deleteEvent(activeSession.id);
      setSessionDialogOpen(false);
      setActiveSession(null);
      setEditBreaks([]);
      await fetchData();
    } catch (e) {
      if (e instanceof ApiError) {
        setSessionSaveError(e.message);
      } else {
        setSessionSaveError('Unable to delete session.');
      }
    } finally {
      setSessionDeleteLoading(false);
    }
  }, [activeSession, fetchData]);

  const openAddEntry = useCallback(() => {
    setNewClockIn('');
    setNewClockOut('');
    setAddEntryError(null);
    setAddEntryOpen(true);
  }, []);

  const handleAddEntry = useCallback(async () => {
    const parsedStart = fromLocalDateTimeInputValue(newClockIn);
    if (parsedStart === null) {
      setAddEntryError('Enter a valid clock-in date and time.');
      return;
    }
    const parsedEnd = fromLocalDateTimeInputValue(newClockOut);
    if (parsedEnd === null) {
      setAddEntryError('Enter a valid clock-out date and time.');
      return;
    }
    const now = Date.now();
    if (parsedStart > now || parsedEnd > now) {
      setAddEntryError('Times cannot be in the future.');
      return;
    }
    if (parsedEnd <= parsedStart) {
      setAddEntryError('Clock-out must be after clock-in.');
      return;
    }
    setAddEntryLoading(true);
    setAddEntryError(null);
    try {
      await clockApi.createManualEntry({
        startTime: parsedStart,
        endTime: parsedEnd,
      });
      setAddEntryOpen(false);
      setNewClockIn('');
      setNewClockOut('');
      await fetchData();
    } catch (e) {
      if (e instanceof ApiError) {
        setAddEntryError(e.message);
      } else {
        setAddEntryError('Unable to create entry.');
      }
    } finally {
      setAddEntryLoading(false);
    }
  }, [newClockIn, newClockOut, fetchData]);

  // Duration previews (display-only, computed from inputs)
  const editDurationSeconds = useMemo(() => {
    if (!editClockIn || !editClockOut) return null;
    const s = fromLocalDateTimeInputValue(editClockIn);
    const e = fromLocalDateTimeInputValue(editClockOut);
    if (!s || !e || e <= s) return null;
    const breakSeconds = editBreaks.reduce((sum, brk) => {
      const bs = fromLocalDateTimeInputValue(brk.start);
      const be = fromLocalDateTimeInputValue(brk.end);
      if (!bs || !be || be <= bs) return sum;
      if (be <= s || bs >= e) return sum;
      const clipStart = Math.max(bs, s);
      const clipEnd = Math.min(be, e);
      if (clipEnd <= clipStart) return sum;
      return sum + Math.floor((clipEnd - clipStart) / 1000);
    }, 0);
    return Math.max(0, Math.floor((e - s) / 1000) - breakSeconds);
  }, [editBreaks, editClockIn, editClockOut]);

  const newDurationSeconds = useMemo(() => {
    if (!newClockIn || !newClockOut) return null;
    const s = fromLocalDateTimeInputValue(newClockIn);
    const e = fromLocalDateTimeInputValue(newClockOut);
    if (!s || !e || e <= s) return null;
    return Math.floor((e - s) / 1000);
  }, [newClockIn, newClockOut]);

  // Team name lookup for edit modal
  const editTeamName = useMemo(() => {
    if (!activeSession) return '';
    return activeSession.teamId
      ? (teams.find((t) => t.id === activeSession.teamId)?.name ?? activeSession.teamId)
      : 'No Team';
  }, [activeSession, teams]);

  const presets = PRESETS;

  // Team-agnostic sessions
  const filteredSessions = useMemo(() => {
    if (!data) return [];
    return data.sessions;
  }, [data]);

  // Recompute summary from filtered sessions
  const filteredSummary = useMemo(() => {
    const completed = filteredSessions.filter((s) => s.endTime !== null);
    const totalSeconds = filteredSessions.reduce(
      (sum, s) => sum + getSessionWorkSeconds(s, currentTime),
      0,
    );
    const totalBreakSeconds = filteredSessions.reduce(
      (sum, s) => sum + getSessionBreakSeconds(s, currentTime),
      0,
    );
    const workingDays = new Set(
      filteredSessions.map((s) =>
        new Date(s.originalStartTime ?? s.startTime).toISOString().slice(0, 10),
      ),
    ).size;
    return {
      totalSeconds,
      totalBreakSeconds,
      totalSessions: filteredSessions.length,
      completedSessions: completed.length,
      averageSessionSeconds: completed.length > 0 ? Math.floor(totalSeconds / completed.length) : 0,
      workingDays,
    };
  }, [filteredSessions, currentTime]);

  if (!teamsReady) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner size="lg" label="Loading…" />
      </div>
    );
  }

  return (
    <AppPage>
      {/* Date range filter + Add Entry */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((p) => (
            <Button
              key={p.key}
              variant={preset === p.key ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<FontAwesomeIcon icon={faPlus} />}
          onClick={openAddEntry}
        >
          Add Entry
        </Button>
      </div>

      {/* Custom date inputs */}
      {preset === 'custom' && (
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
          <Input
            label="Start"
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            size="sm"
          />
          <Input
            label="End"
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            size="sm"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={fetchData}
            disabled={loading || !customStart || !customEnd}
            isLoading={loading}
            loadingText="Applying…"
            className="w-full md:w-auto"
          >
            Apply
          </Button>
        </div>
      )}

      {/* Summary stats */}
      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Card>
            <CardContent>
              <Text variant="muted" size="xs">
                Total Hours
              </Text>
              <Text size="lg" weight="semibold">
                {formatDuration(filteredSummary.totalSeconds)}
              </Text>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Text variant="muted" size="xs">
                Break Hours
              </Text>
              <Text size="lg" weight="semibold">
                {formatDuration(filteredSummary.totalBreakSeconds)}
              </Text>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Text variant="muted" size="xs">
                Sessions
              </Text>
              <Text size="lg" weight="semibold">
                {filteredSummary.totalSessions}
              </Text>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Text variant="muted" size="xs">
                Avg Session
              </Text>
              <Text size="lg" weight="semibold">
                {formatDuration(filteredSummary.averageSessionSeconds)}
              </Text>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Text variant="muted" size="xs">
                Working Days
              </Text>
              <Text size="lg" weight="semibold">
                {filteredSummary.workingDays}
              </Text>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center p-8">
          <Spinner label="Loading timesheet…" />
        </div>
      )}

      {/* Error */}
      {error && (
        <Alert variant="danger" dismissible>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Sessions list */}
      {data && filteredSessions.length > 0 && (
        <Card padding="none">
          <CardHeader className="px-5 py-3">
            <CardTitle className="text-sm">Sessions ({filteredSessions.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table responsive>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Clock In</TableHead>
                  <TableHead>Clock Out</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSessions.map((s) => (
                  <TimesheetRow key={s.id} session={s} teams={teams} onEdit={openSessionDialog} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Modal
        open={sessionDialogOpen}
        onOpenChange={(open) => {
          setSessionDialogOpen(open);
          if (!open) {
            setActiveSession(null);
            setEditBreaks([]);
            setSessionSaveError(null);
          }
        }}
        aria-labelledby="edit-session-title"
      >
        <ModalHeader>
          <Text weight="semibold" id="edit-session-title">
            Edit Session
          </Text>
        </ModalHeader>
        <ModalBody className="space-y-4">
          {editTeamName && (
            <div className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2 dark:bg-neutral-800">
              <Text size="xs" variant="muted">
                Team
              </Text>
              <Text size="sm" weight="medium">
                {editTeamName}
              </Text>
            </div>
          )}
          <Input
            label="Clock In"
            type="datetime-local"
            value={editClockIn}
            onChange={(e) => setEditClockIn(e.target.value)}
          />
          <Input
            label="Clock Out"
            type="datetime-local"
            value={editClockOut}
            onChange={(e) => setEditClockOut(e.target.value)}
            placeholder="Leave blank to keep active"
          />
          {editDurationSeconds !== null && (
            <div className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2 dark:bg-neutral-800">
              <Text size="xs" variant="muted">
                Duration
              </Text>
              <Text size="sm" weight="medium">
                {formatDuration(editDurationSeconds)}
              </Text>
            </div>
          )}
          <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
            <div className="flex items-center justify-between">
              <Text size="sm" weight="medium">
                Breaks
              </Text>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setEditBreaks((prev) => [
                    ...prev,
                    {
                      id: `new-break-${Date.now()}-${prev.length}`,
                      start: '',
                      end: '',
                    },
                  ])
                }
                disabled={sessionSaveLoading || sessionDeleteLoading}
              >
                Add Break
              </Button>
            </div>
            {editBreaks.length === 0 ? (
              <Text size="xs" variant="muted">
                No breaks configured.
              </Text>
            ) : (
              <div className="space-y-3">
                {editBreaks.map((brk, idx) => (
                  <div
                    key={brk.id}
                    className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700"
                  >
                    <Text size="xs" variant="muted">
                      Break {idx + 1}
                    </Text>
                    <Input
                      label="Break Start"
                      type="datetime-local"
                      value={brk.start}
                      onChange={(e) =>
                        setEditBreaks((prev) =>
                          prev.map((entry) =>
                            entry.id === brk.id ? { ...entry, start: e.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <Input
                      label="Break End"
                      type="datetime-local"
                      value={brk.end}
                      onChange={(e) =>
                        setEditBreaks((prev) =>
                          prev.map((entry) =>
                            entry.id === brk.id ? { ...entry, end: e.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="Leave blank for open break"
                    />
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditBreaks((prev) => prev.filter((entry) => entry.id !== brk.id))
                        }
                        disabled={sessionSaveLoading || sessionDeleteLoading}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {sessionSaveError && (
            <Text size="xs" className="text-danger">
              {sessionSaveError}
            </Text>
          )}
          {activeSession && (
            <AttachmentsPanel kind="clock" entityId={activeSession.id} currentUserId={user?.id} />
          )}
        </ModalBody>
        <ModalFooter>
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={handleSaveSession}
              isLoading={sessionSaveLoading}
              disabled={sessionDeleteLoading}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => setSessionDialogOpen(false)}
              disabled={sessionSaveLoading || sessionDeleteLoading}
            >
              Cancel
            </Button>
            {activeSession?.endTime !== null && (
              <Button
                variant="danger"
                className="ml-auto"
                onClick={handleDeleteSession}
                isLoading={sessionDeleteLoading}
                disabled={sessionSaveLoading}
              >
                Delete
              </Button>
            )}
          </div>
        </ModalFooter>
      </Modal>

      {/* Add Entry modal */}
      <Modal
        open={addEntryOpen}
        onOpenChange={(open) => {
          setAddEntryOpen(open);
          if (!open) setAddEntryError(null);
        }}
        aria-labelledby="add-entry-title"
      >
        <ModalHeader>
          <Text weight="semibold" id="add-entry-title">
            Add Past Entry
          </Text>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <Input
            label="Clock In"
            type="datetime-local"
            value={newClockIn}
            onChange={(e) => setNewClockIn(e.target.value)}
          />
          <Input
            label="Clock Out"
            type="datetime-local"
            value={newClockOut}
            onChange={(e) => setNewClockOut(e.target.value)}
          />
          {newDurationSeconds !== null && (
            <div className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2 dark:bg-neutral-800">
              <Text size="xs" variant="muted">
                Duration
              </Text>
              <Text size="sm" weight="medium">
                {formatDuration(newDurationSeconds)}
              </Text>
            </div>
          )}
          {addEntryError && (
            <Text size="xs" className="text-danger">
              {addEntryError}
            </Text>
          )}
        </ModalBody>
        <ModalFooter>
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button variant="primary" onClick={handleAddEntry} isLoading={addEntryLoading}>
              Save Entry
            </Button>
            <Button
              variant="ghost"
              onClick={() => setAddEntryOpen(false)}
              disabled={addEntryLoading}
            >
              Cancel
            </Button>
          </div>
        </ModalFooter>
      </Modal>

      {data && filteredSessions.length === 0 && !loading && (
        <Card variant="outlined" padding="lg" className="border-dashed text-center">
          <CardContent>
            <FontAwesomeIcon
              icon={faCalendar}
              className="mb-2 text-2xl text-neutral-300 dark:text-neutral-600"
            />
            <Text variant="muted" size="sm">
              No clock events in this date range.
            </Text>
          </CardContent>
        </Card>
      )}
    </AppPage>
  );
};
