/**
 * AdminTimesheetPanel — Timesheet view for team admins/leaders.
 *
 * Allows selecting any member of the current team and viewing their
 * clock-in / clock-out history with the same date range presets and
 * edit/delete capabilities as the personal TimesheetPage.
 *
 * Authorization:
 *   • The backend allows only team admins to VIEW another member's sessions.
 *   • Edit/delete is allowed only for admins (enforced server-side).
 */
import { faCalendar, faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';
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
  Select,
  Spinner,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '@mieweb/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, clockApi, type ClockEvent } from '../../lib/api';
import { formatDuration } from '../../lib/timeUtils';
import { type TeamMember } from '../../lib/api';
import { AdminDayGroup } from './AdminDayGroup';
import {
  fromLocalDateTimeInputValue,
  getDateRange,
  PRESETS,
  toLocalDateTimeInputValue,
  type Preset,
} from '../clock/timesheetUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimpleTeam {
  id: string;
  name: string;
}

interface TimesheetData {
  sessions: ClockEvent[];
  summary: {
    totalSeconds: number;
    totalSessions: number;
    completedSessions: number;
    averageSessionSeconds: number;
    workingDays: number;
  };
}

interface Props {
  members: TeamMember[];
  selectedTeamId: string | null;
  teams: SimpleTeam[];
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

// ─── Component ────────────────────────────────────────────────────────────────

export const AdminTimesheetPanel: React.FC<Props> = ({ members, selectedTeamId, teams }) => {
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<Preset>('week');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TimesheetData | null>(null);

  // Edit modal state
  const [activeSession, setActiveSession] = useState<ClockEvent | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [sessionSaveLoading, setSessionSaveLoading] = useState(false);
  const [sessionDeleteLoading, setSessionDeleteLoading] = useState(false);
  const [sessionSaveError, setSessionSaveError] = useState<string | null>(null);

  // When the team changes, reset member selection
  useEffect(() => {
    setSelectedMemberId('');
    setData(null);
  }, [selectedTeamId]);

  // Auto-select first member when member list loads
  useEffect(() => {
    if (members.length > 0 && !selectedMemberId) {
      setSelectedMemberId(members[0].id);
    }
  }, [members, selectedMemberId]);

  const fetchData = useCallback(async () => {
    if (!selectedMemberId) return;
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
      const result = await clockApi.getTimesheet(selectedMemberId, startMs, endMs);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load timesheet');
    } finally {
      setLoading(false);
    }
  }, [selectedMemberId, preset, customStart, customEnd]);

  // Refetch when member or non-custom preset changes
  useEffect(() => {
    if (selectedMemberId && preset !== 'custom') {
      void fetchData();
    }
  }, [selectedMemberId, preset]);

  // Filter sessions to selected team only
  const filteredSessions = useMemo(() => {
    if (!data) return [];
    return data.sessions;
  }, [data]);

  // Group filtered sessions by calendar day (descending date order)
  const groupedByDay = useMemo(() => {
    const map = new Map<string, ClockEvent[]>();
    for (const session of filteredSessions) {
      const dayKey = new Date(session.originalStartTime ?? session.startTime)
        .toISOString()
        .slice(0, 10);
      const bucket = map.get(dayKey);
      if (bucket) {
        bucket.push(session);
      } else {
        map.set(dayKey, [session]);
      }
    }
    // Sort entries descending by date
    return new Map([...map.entries()].sort((a, b) => b[0].localeCompare(a[0])));
  }, [filteredSessions]);

  const allExpanded = expandedDays.size > 0;

  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedDays(new Set());
    } else {
      setExpandedDays(new Set(groupedByDay.keys()));
    }
  }, [allExpanded, groupedByDay]);

  const toggleDay = useCallback((dayKey: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) {
        next.delete(dayKey);
      } else {
        next.add(dayKey);
      }
      return next;
    });
  }, []);

  // Recompute summary from filtered sessions
  const filteredSummary = useMemo(() => {
    const now = Date.now();
    const completed = filteredSessions.filter((s) => s.endTime !== null);
    const totalSeconds = filteredSessions.reduce(
      (sum, s) => sum + getSessionWorkSeconds(s, now),
      0,
    );
    const workingDays = new Set(
      filteredSessions.map((s) => {
        const sessionStart = s.originalStartTime ?? s.startTime;
        return new Date(sessionStart).toISOString().slice(0, 10);
      }),
    ).size;
    return {
      totalSeconds,
      totalSessions: filteredSessions.length,
      completedSessions: completed.length,
      averageSessionSeconds: completed.length > 0 ? Math.floor(totalSeconds / completed.length) : 0,
      workingDays,
    };
  }, [filteredSessions]);

  // ── Edit modal handlers ──

  const openSessionDialog = useCallback((session: ClockEvent) => {
    setActiveSession(session);
    setEditClockIn(toLocalDateTimeInputValue(session.startTime));
    setEditClockOut(session.endTime ? toLocalDateTimeInputValue(session.endTime) : '');
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

    let parsedEnd: number | null = null;
    if (editClockOut.trim()) {
      parsedEnd = fromLocalDateTimeInputValue(editClockOut);
      if (parsedEnd === null) {
        setSessionSaveError('Enter a valid clock-out date and time, or leave it blank.');
        return;
      }
    }

    setSessionSaveLoading(true);
    setSessionSaveError(null);
    try {
      await clockApi.updateTimes(activeSession.id, {
        startTime: parsedStart,
        endTime: parsedEnd,
      });
      setSessionDialogOpen(false);
      setActiveSession(null);
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
  }, [activeSession, editClockIn, editClockOut, fetchData]);

  const handleDeleteSession = useCallback(async () => {
    if (!activeSession) return;

    setSessionDeleteLoading(true);
    setSessionSaveError(null);
    try {
      await clockApi.deleteEvent(activeSession.id);
      setSessionDialogOpen(false);
      setActiveSession(null);
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

  // ── Member select options ──
  const memberOptions = useMemo(
    () => members.map((m) => ({ value: m.id, label: m.name || m.email || m.id })),
    [members],
  );

  if (members.length === 0) {
    return (
      <Card variant="outlined" padding="lg" className="border-dashed text-center">
        <CardContent>
          <Text variant="muted" size="sm">
            No members in this team yet.
          </Text>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Member selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
        <div className="w-full sm:w-64">
          <Select
            label="Member"
            value={selectedMemberId}
            onValueChange={(val) => setSelectedMemberId(val)}
            options={memberOptions}
          />
        </div>
      </div>

      {/* Date range presets */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
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
            disabled={loading || !customStart || !customEnd || !selectedMemberId}
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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

      {/* Sessions table */}
      {data && filteredSessions.length > 0 && (
        <Card padding="none">
          <CardHeader className="flex items-center justify-between px-5 py-3">
            <CardTitle className="text-sm">
              {groupedByDay.size} {groupedByDay.size === 1 ? 'day' : 'days'} &middot;{' '}
              {filteredSessions.length} sessions
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleExpandAll}
              aria-label={allExpanded ? 'Collapse all days' : 'Expand all days'}
            >
              <FontAwesomeIcon
                icon={allExpanded ? faChevronUp : faChevronDown}
                className="mr-1.5 text-xs"
              />
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </Button>
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
                {[...groupedByDay.entries()].map(([dayKey, daySessions]) => (
                  <AdminDayGroup
                    key={dayKey}
                    sessions={daySessions}
                    teams={teams}
                    onEdit={openSessionDialog}
                    isExpanded={expandedDays.has(dayKey)}
                    onToggle={() => toggleDay(dayKey)}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
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

      {/* Edit session modal */}
      <Modal
        open={sessionDialogOpen}
        onOpenChange={(open) => {
          setSessionDialogOpen(open);
          if (!open) {
            setActiveSession(null);
            setSessionSaveError(null);
          }
        }}
        aria-labelledby="admin-edit-session-title"
      >
        <ModalHeader>
          <Text weight="semibold" id="admin-edit-session-title">
            Edit Session
          </Text>
        </ModalHeader>
        <ModalBody className="space-y-4">
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
          {sessionSaveError && (
            <Text size="xs" className="text-danger">
              {sessionSaveError}
            </Text>
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
    </div>
  );
};
