/**
 * ClockPage — Clock in/out with live session timer.
 */
import { faCircleStop, faStopwatch } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner, Text } from '@mieweb/ui';
import React from 'react';

import { useTeam } from '../../lib/TeamContext';
import { formatTimer, getActiveClockSeconds } from '../../lib/timeUtils';
import { AppPage } from '../../ui/AppPage';
import { useClockToggle } from '../../lib/useClockToggle';
import { useRouter } from '../../ui/router';

// ─── ClockPage ────────────────────────────────────────────────────────────────

export const ClockPage: React.FC = () => {
  const { activeClockEvent, currentTime, teamsReady } = useTeam();
  const { navigate } = useRouter();

  const {
    clockIn,
    clockOut,
    pauseClock,
    resumeClock,
    clockInLoading,
    clockOutLoading,
    clockPauseLoading,
  } = useClockToggle();

  // Session duration
  const sessionSeconds = getActiveClockSeconds(activeClockEvent, currentTime);
  const isPaused = !!activeClockEvent?.isPaused;

  // Live wall-clock display
  const currentTimeDisplay = new Date(currentTime).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const currentDateDisplay = new Date(currentTime).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!teamsReady) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner size="lg" label="Loading…" />
      </div>
    );
  }

  return (
    <AppPage>
      {/* ── Clock Button ── */}
      <Card padding="lg" className="relative rounded-2xl">
        <CardContent className="flex flex-col-reverse items-center gap-4 sm:flex-row sm:items-center">
          {/* Clock button — full width on mobile, 1/4 on sm+ */}
          <div className="flex w-full flex-col items-center gap-2 sm:w-1/4">
            {activeClockEvent ? (
              <>
                <Button
                  onClick={clockOut}
                  isLoading={clockOutLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-2xl bg-red-500 py-4 text-white shadow-lg transition-transform hover:scale-[1.02] hover:bg-red-600 active:scale-95 disabled:opacity-50 sm:h-16 sm:w-16 sm:rounded-full sm:py-0"
                  aria-label="Clock out"
                >
                  <FontAwesomeIcon icon={faCircleStop} className="text-2xl" />
                  <span className="text-sm font-semibold sm:hidden">Clock Out</span>
                </Button>
                <Button
                  onClick={isPaused ? resumeClock : pauseClock}
                  isLoading={clockPauseLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-2xl bg-amber-500 py-3 text-white shadow-lg transition-transform hover:scale-[1.02] hover:bg-amber-600 active:scale-95 disabled:opacity-50 sm:w-28"
                  aria-label={isPaused ? 'Resume work' : 'Start break'}
                >
                  <span className="text-sm font-semibold">{isPaused ? 'Resume' : 'Break'}</span>
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={clockIn}
                  isLoading={clockInLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-2xl bg-green-500 py-4 text-white shadow-lg transition-transform hover:scale-[1.02] hover:bg-green-600 active:scale-95 disabled:opacity-50 sm:h-16 sm:w-16 sm:rounded-full sm:py-0"
                  aria-label="Clock in"
                >
                  <FontAwesomeIcon icon={faStopwatch} className="text-2xl" />
                  <span className="text-sm font-semibold sm:hidden">Clock In</span>
                </Button>
              </>
            )}
          </div>

          {/* Time display — full width on mobile, 3/4 on sm+; border switches from top to left */}
          <div className="flex w-full flex-col items-center gap-1 border-b border-neutral-200 pb-4 text-center dark:border-neutral-700 sm:w-3/4 sm:items-start sm:border-b-0 sm:border-l sm:pb-0 sm:pl-4 sm:text-left">
            <div className="font-mono text-4xl font-bold leading-none tabular-nums">
              {currentTimeDisplay}
            </div>
            <Text variant="muted" size="sm">
              {currentDateDisplay}
            </Text>
            {activeClockEvent ? (
              <Text
                variant={isPaused ? 'warning' : 'success'}
                size="xs"
                weight="medium"
                className="mt-1 uppercase tracking-widest"
              >
                {isPaused ? 'On break' : 'Session active'} — {formatTimer(sessionSeconds)}
              </Text>
            ) : (
              <Text
                variant="muted"
                size="xs"
                weight="medium"
                className="mt-1 uppercase tracking-widest"
              >
                Ready to work
              </Text>
            )}
          </div>
        </CardContent>
        <span className="block px-5 pb-3 font-mono text-xs text-neutral-400 text-center dark:text-neutral-500 sm:absolute sm:bottom-3 sm:right-4 sm:px-0 sm:pb-0 sm:text-right">
          {timeZone}
        </span>
      </Card>

      {/* ── Quick Ticket Creation ── */}
      {activeClockEvent && (
        <Card padding="none">
          <CardHeader className="flex flex-row items-center justify-between px-5 py-3">
            <CardTitle className="text-sm">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="px-5 py-4">
            <Text variant="muted" size="sm">
              Coming soon… In the meantime, track your time on the{' '}
              <button
                type="button"
                onClick={() => navigate('/app/work')}
                className="text-blue-500 hover:underline"
              >
                Work
              </button>{' '}
              page or manage your{' '}
              <button
                type="button"
                onClick={() => navigate('/app/tickets')}
                className="text-blue-500 hover:underline"
              >
                Tickets
              </button>
              .
            </Text>
          </CardContent>
        </Card>
      )}
    </AppPage>
  );
};
