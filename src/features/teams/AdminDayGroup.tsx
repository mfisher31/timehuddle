/**
 * AdminDayGroup — Renders a collapsible summary row for a single calendar day
 * in the admin timesheet, with all individual sessions expandable below it.
 *
 * Summary row shows aggregated values across all sessions that day.
 * Clicking the row (or the chevron) toggles the expanded detail view, which
 * renders one TimesheetRow per session — identical to the personal timesheet.
 */
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Badge, Button, TableCell, TableRow, Text } from '@mieweb/ui';
import React from 'react';

import { type ClockEvent } from '../../lib/api';
import { formatDate, formatDuration, formatTime } from '../../lib/timeUtils';
import { TimesheetRow } from '../clock/TimesheetRow';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string;
  name: string;
}

interface Props {
  sessions: ClockEvent[];
  teams: Team[];
  onEdit: (session: ClockEvent) => void;
  isExpanded: boolean;
  onToggle: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export const AdminDayGroup: React.FC<Props> = ({
  sessions,
  teams,
  onEdit,
  isExpanded,
  onToggle,
}) => {
  const now = Date.now();

  const hasActiveSession = sessions.some((s) => s.endTime === null);
  const totalWorkSeconds = sessions.reduce((sum, s) => sum + getSessionWorkSeconds(s, now), 0);

  // Earliest clock-in of the day
  const earliestStart = Math.min(...sessions.map((s) => s.originalStartTime ?? s.startTime));

  // Latest clock-out (null if any session is still active)
  const latestEnd = hasActiveSession ? null : Math.max(...sessions.map((s) => s.endTime as number));

  // Team: single name if all sessions share a team, otherwise "Multiple"
  const teamIds = [...new Set(sessions.map((s) => s.teamId).filter(Boolean))] as string[];
  const teamLabel =
    teamIds.length === 0
      ? 'No Team'
      : teamIds.length === 1
        ? (teams.find((t) => t.id === teamIds[0])?.name ?? teamIds[0])
        : 'Multiple';

  // Sessions sorted descending for the expanded view (newest first)
  const sortedSessions = sessions
    .slice()
    .sort((a, b) => (b.originalStartTime ?? b.startTime) - (a.originalStartTime ?? a.startTime));

  return (
    <>
      {/* ── Day summary row ── */}
      <TableRow
        className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
        onClick={onToggle}
      >
        <TableCell>{formatDate(new Date(earliestStart), true)}</TableCell>
        <TableCell>{formatTime(new Date(earliestStart))}</TableCell>
        <TableCell>
          {latestEnd === null ? (
            <Text variant="muted" size="xs">
              —
            </Text>
          ) : (
            formatTime(new Date(latestEnd))
          )}
        </TableCell>
        <TableCell className="font-mono">{formatDuration(totalWorkSeconds)}</TableCell>
        <TableCell>{teamLabel}</TableCell>
        <TableCell>
          {hasActiveSession ? (
            <Badge variant="success" size="sm">
              <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
              Active
            </Badge>
          ) : (
            <Text variant="muted" size="xs">
              {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
            </Text>
          )}
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="icon"
            aria-label={isExpanded ? 'Collapse day' : 'Expand day'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <FontAwesomeIcon
              icon={isExpanded ? faChevronDown : faChevronRight}
              className="text-sm"
            />
          </Button>
        </TableCell>
      </TableRow>

      {/* ── Expanded session rows ── */}
      {isExpanded &&
        sortedSessions.map((session) => (
          <TimesheetRow key={session.id} session={session} teams={teams} onEdit={onEdit} />
        ))}
    </>
  );
};
