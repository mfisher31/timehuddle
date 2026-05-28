/**
 * TimesheetRow — Renders one or more <TableRow>s for a single clock session.
 *
 * A session that spans midnight is split into per-calendar-day segments.
 * Continuation segments show "---" for clock-in (on all but the first day)
 * and "---" for clock-out (on all but the last day), making it clear the
 * session carried over from / into an adjacent day.
 */
import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Badge, Button, TableCell, TableRow, Text } from '@mieweb/ui';
import React from 'react';

import { formatDate, formatDuration, formatTime } from '../../lib/timeUtils';
import { type ClockEvent } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string;
  name: string;
}

interface Props {
  session: ClockEvent;
  teams: Team[];
  onEdit: (session: ClockEvent) => void;
}

type TimelineRow = {
  kind: 'work' | 'break';
  start: number;
  end: number | null;
  durationSeconds: number | null;
  status: 'Completed' | 'Active' | 'Break Period' | 'On Break';
  /** Segment is a continuation from the previous calendar day — show "---" for clock-in */
  isContinuation?: boolean;
  /** Segment continues into the next calendar day — show "---" for clock-out */
  isContinued?: boolean;
};

function buildTimelineRows(session: ClockEvent, now: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const sessionStart = session.originalStartTime ?? session.startTime;
  const sessionEnd = session.endTime ?? now;
  const rawBreaks = Array.isArray(session.breaks) ? session.breaks : [];
  const breaks = rawBreaks
    .filter((b) => typeof b.startTime === 'number')
    .map((b) => ({
      startTime: b.startTime,
      endTime: typeof b.endTime === 'number' ? b.endTime : null,
    }))
    .sort((a, b) => a.startTime - b.startTime);

  let cursor = sessionStart;
  for (const brk of breaks) {
    const breakStart = Math.max(cursor, brk.startTime);
    if (breakStart > cursor) {
      const durationSeconds = Math.max(0, Math.floor((breakStart - cursor) / 1000));
      rows.push({
        kind: 'work',
        start: cursor,
        end: breakStart,
        durationSeconds,
        status: 'Completed',
      });
    }

    const breakEnd = brk.endTime ?? (session.endTime === null ? null : sessionEnd);
    const breakDuration =
      breakEnd === null
        ? Math.max(0, Math.floor((now - breakStart) / 1000))
        : Math.max(0, Math.floor((breakEnd - breakStart) / 1000));

    rows.push({
      kind: 'break',
      start: breakStart,
      end: breakEnd,
      durationSeconds: breakDuration,
      status: breakEnd === null ? 'On Break' : 'Break Period',
    });

    if (breakEnd !== null) {
      cursor = breakEnd;
    }
  }

  if (session.endTime === null && session.isPaused && !rows.some((row) => row.kind === 'break')) {
    const breakStart = typeof session.pausedAt === 'number' ? session.pausedAt : session.startTime;
    rows.push({
      kind: 'break',
      start: breakStart,
      end: null,
      durationSeconds: Math.max(0, Math.floor((now - breakStart) / 1000)),
      status: 'On Break',
    });
  }

  const shouldAddTrailingWork =
    session.endTime === null ? !session.isPaused && cursor <= sessionEnd : cursor < sessionEnd;

  if (shouldAddTrailingWork) {
    const end = session.endTime === null ? null : sessionEnd;
    const durationSeconds =
      end === null
        ? Math.max(0, Math.floor((now - cursor) / 1000))
        : Math.max(0, Math.floor((end - cursor) / 1000));
    rows.push({
      kind: 'work',
      start: cursor,
      end,
      durationSeconds,
      status: end === null ? 'Active' : 'Completed',
    });
  }

  return rows.sort((a, b) => b.start - a.start);
}

/** Returns the next midnight (start of tomorrow, local time) as a ms timestamp. */
function nextMidnight(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Splits timeline rows that cross a calendar-day boundary into per-day segments.
 * The first segment gets `isContinued = true` (no clock-out shown).
 * Subsequent segments get `isContinuation = true` (no clock-in shown).
 * Result is re-sorted descending by start so newest rows appear first.
 */
function splitAtMidnight(rows: TimelineRow[]): TimelineRow[] {
  const result: TimelineRow[] = [];
  for (const row of rows) {
    if (row.end === null) {
      result.push(row);
      continue;
    }
    const startDate = new Date(row.start);
    const endDate = new Date(row.end);
    const sameDay =
      startDate.getFullYear() === endDate.getFullYear() &&
      startDate.getMonth() === endDate.getMonth() &&
      startDate.getDate() === endDate.getDate();
    if (sameDay) {
      result.push(row);
      continue;
    }
    // Spans at least one midnight — split into per-calendar-day segments.
    let cursor = row.start;
    while (true) {
      const midnight = nextMidnight(cursor);
      if (midnight >= row.end) {
        // Final segment
        result.push({
          ...row,
          start: cursor,
          end: row.end,
          durationSeconds: Math.max(0, Math.floor((row.end - cursor) / 1000)),
          isContinuation: cursor !== row.start,
          isContinued: false,
        });
        break;
      } else {
        // Non-final segment — clip at midnight
        result.push({
          ...row,
          start: cursor,
          end: midnight,
          durationSeconds: Math.max(0, Math.floor((midnight - cursor) / 1000)),
          isContinuation: cursor !== row.start,
          isContinued: true,
        });
        cursor = midnight;
      }
    }
  }
  return result.sort((a, b) => b.start - a.start);
}

// ─── Component ────────────────────────────────────────────────────────────────

export const TimesheetRow: React.FC<Props> = ({ session, teams, onEdit }) => {
  const teamName = session.teamId
    ? (teams.find((t) => t.id === session.teamId)?.name ?? session.teamId)
    : 'No Team';
  const timelineRows = splitAtMidnight(buildTimelineRows(session, Date.now()));

  return (
    <>
      {timelineRows.map((row, idx) => {
        const showActions = idx === 0;
        // Team name belongs on the chronologically-first segment (last in desc-sorted array)
        const showTeam = idx === timelineRows.length - 1;
        return (
          <TableRow key={`${session.id}-${row.kind}-${idx}`}>
            <TableCell>{formatDate(new Date(row.start), true)}</TableCell>
            <TableCell>
              {row.isContinuation ? (
                <Text variant="muted" size="xs">
                  ---
                </Text>
              ) : (
                formatTime(new Date(row.start))
              )}
            </TableCell>
            <TableCell>
              {row.isContinued ? (
                <Text variant="muted" size="xs">
                  ---
                </Text>
              ) : row.end === null ? (
                <Text variant="muted" size="xs">
                  —
                </Text>
              ) : (
                formatTime(new Date(row.end))
              )}
            </TableCell>
            <TableCell className="font-mono">
              {row.durationSeconds !== null ? formatDuration(row.durationSeconds) : '—'}
            </TableCell>
            <TableCell>{showTeam ? teamName : ''}</TableCell>
            <TableCell>
              {row.isContinued ? null : row.status === 'Active' ? (
                <Badge variant="success" size="sm">
                  <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                  Active
                </Badge>
              ) : row.status === 'On Break' ? (
                <Badge variant="warning" size="sm">
                  On Break
                </Badge>
              ) : (
                <Text variant="muted" size="xs">
                  {row.status}
                </Text>
              )}
            </TableCell>
            <TableCell className="text-right">
              {showActions && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit session"
                  onClick={() => onEdit(session)}
                >
                  <FontAwesomeIcon icon={faEllipsisVertical} className="text-sm" />
                </Button>
              )}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
};
