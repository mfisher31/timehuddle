/**
 * DashboardPage — Overview of the user's workspace.
 *
 * Shows:
 *   • Quick stats: Today's hours, Week hours, Active sessions, Teams
 *   • Team selector
 *   • Active clock session (if any)
 *   • Recent activity (last 5 clock events)
 *   • First-time user welcome cards (if no teams or events)
 */
import {
  faClock,
  faPlay,
  faUsers,
  faCalendarWeek,
  faArrowRight,
  faPlus,
  faRightToBracket,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  Text,
} from '@mieweb/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { clockApi, type ClockEvent } from '../../lib/api';
import { useSession } from '../../lib/useSession';
import { useTeam } from '../../lib/TeamContext';
import { useRefresh } from '../../lib/RefreshContext';
import { formatDuration, formatTime, formatDate, startOfDay } from '../../lib/timeUtils';
import { useRouter } from '../../ui/router';
import { AppPage } from '../../ui/AppPage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeHours(events: ClockEvent[], after: number, now: number): number {
  let total = 0;
  for (const e of events) {
    if (e.startTime < after) continue;
    const end = e.endTime ?? now;
    total += (end - e.startTime) / 1000;
  }
  return total;
}

// ─── DashboardPage ────────────────────────────────────────────────────────────

export const DashboardPage: React.FC = () => {
  const { user } = useSession();
  const { navigate } = useRouter();
  const { teams, teamsReady, activeClockEvent, currentTime } = useTeam();

  // All user clock events (from timecore REST)
  const [allEvents, setAllEvents] = useState<ClockEvent[]>([]);
  useEffect(() => {
    if (!user) return;
    clockApi
      .getEvents()
      .then(setAllEvents)
      .catch(() => setAllEvents([]));
  }, [user]);

  // Pull-to-refresh
  useRefresh(
    React.useCallback(async () => {
      if (!user) return;
      await clockApi
        .getEvents()
        .then(setAllEvents)
        .catch(() => {});
    }, [user]),
  );

  const teamEvents = useMemo(() => allEvents, [allEvents]);

  // Compute stats
  const todayStart = useMemo(() => startOfDay(new Date()).getTime(), []);
  const weekStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const todayHours = useMemo(
    () => computeHours(teamEvents, todayStart, currentTime),
    [teamEvents, todayStart, currentTime],
  );

  const weekHours = useMemo(
    () => computeHours(teamEvents, weekStart, currentTime),
    [teamEvents, weekStart, currentTime],
  );

  const activeSessions = useMemo(() => teamEvents.filter((e) => !e.endTime).length, [teamEvents]);

  const recentEvents = useMemo(() => teamEvents.filter((e) => e.endTime).slice(0, 5), [teamEvents]);

  const isFirstTime = teams.length <= 1 && teamEvents.length === 0;

  if (!teamsReady) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner size="lg" label="Loading dashboard…" />
      </div>
    );
  }

  return (
    <AppPage>
      {/* First time user welcome */}
      {isFirstTime && (
        <Card variant="outlined" padding="lg" className="text-center">
          <CardContent>
            <Text as="h2" size="lg" weight="semibold">
              Welcome to TimeHuddle
            </Text>
            <Text variant="muted" size="sm" className="mt-2">
              Get started by creating or joining a team, then clock in to start tracking time.
            </Text>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button
                variant="primary"
                leftIcon={<FontAwesomeIcon icon={faPlus} />}
                onClick={() => navigate('/app/teams')}
              >
                Create Team
              </Button>
              <Button
                variant="outline"
                leftIcon={<FontAwesomeIcon icon={faRightToBracket} />}
                onClick={() => navigate('/app/teams')}
              >
                Join Team
              </Button>
              <Button
                variant="outline"
                leftIcon={<FontAwesomeIcon icon={faClock} />}
                onClick={() => navigate('/app/clock')}
              >
                Track Solo
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card padding="sm">
          <CardContent className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
              <FontAwesomeIcon icon={faClock} className="text-sm" />
            </div>
            <div>
              <Text variant="muted" size="xs">
                Today
              </Text>
              <Text size="lg" weight="semibold">
                {formatDuration(todayHours)}
              </Text>
            </div>
          </CardContent>
        </Card>
        <Card padding="sm">
          <CardContent className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400">
              <FontAwesomeIcon icon={faCalendarWeek} className="text-sm" />
            </div>
            <div>
              <Text variant="muted" size="xs">
                This Week
              </Text>
              <Text size="lg" weight="semibold">
                {formatDuration(weekHours)}
              </Text>
            </div>
          </CardContent>
        </Card>
        <Card padding="sm">
          <CardContent className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${activeSessions > 0 ? 'bg-green-50 text-green-600 dark:bg-green-950/50 dark:text-green-400' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}
            >
              <FontAwesomeIcon icon={faPlay} className="text-sm" />
            </div>
            <div>
              <Text variant="muted" size="xs">
                Active
              </Text>
              <Text size="lg" weight="semibold">
                {String(activeSessions)}
              </Text>
            </div>
          </CardContent>
        </Card>
        <Card padding="sm">
          <CardContent className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400">
              <FontAwesomeIcon icon={faUsers} className="text-sm" />
            </div>
            <div>
              <Text variant="muted" size="xs">
                Teams
              </Text>
              <Text size="lg" weight="semibold">
                {String(teams.filter((t) => !t.isPersonal).length)}
              </Text>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Active session banner */}
      {activeClockEvent && (
        <Alert
          variant="success"
          icon={<div className="h-3 w-3 animate-pulse rounded-full bg-green-500" />}
        >
          <AlertTitle>Session Active</AlertTitle>
          <AlertDescription>
            Started {formatTime(new Date(activeClockEvent.startTime))} •{' '}
            {formatDuration(Math.floor((currentTime - activeClockEvent.startTime) / 1000))}
          </AlertDescription>
          <Button
            variant="primary"
            size="sm"
            className="mt-2"
            rightIcon={<FontAwesomeIcon icon={faArrowRight} />}
            onClick={() => navigate('/app/clock')}
          >
            View
          </Button>
        </Alert>
      )}

      {/* Recent Activity */}
      {recentEvents.length > 0 && (
        <Card padding="none">
          <CardHeader className="flex flex-row items-center justify-between px-5 py-3">
            <CardTitle className="text-sm">Recent Activity</CardTitle>
            <Button variant="link" size="sm" onClick={() => navigate('/app/timesheet')}>
              View all →
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {recentEvents.map((event) => {
                const start = new Date(event.startTime);
                const end = event.endTime ? new Date(event.endTime) : null;
                const durSec = end ? (end.getTime() - event.startTime) / 1000 : 0;
                const team = event.teamId ? teams.find((t) => t.id === event.teamId) : null;
                return (
                  <li key={event.id} className="flex items-center justify-between px-5 py-3">
                    <div className="min-w-0">
                      <Text size="sm" weight="medium">
                        {formatDate(start)} • {formatTime(start)}
                        {end ? ` – ${formatTime(end)}` : ''}
                      </Text>
                      <Text variant="muted" size="xs" className="mt-0.5">
                        {team?.isPersonal
                          ? 'Personal'
                          : (team?.name ?? (event.teamId ? 'Unknown Team' : 'No Team'))}
                      </Text>
                    </div>
                    <Badge variant="secondary" size="sm">
                      {formatDuration(durSec)}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </AppPage>
  );
};
