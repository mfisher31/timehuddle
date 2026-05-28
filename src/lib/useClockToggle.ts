/**
 * useClockToggle — Shared clock-in / clock-out logic.
 *
 * Encapsulates the API calls and loading states.
 */
import { useCallback, useState } from 'react';

import { clockApi } from './api';
import { useTeam } from './TeamContext';

export function useClockToggle() {
  const { activeClockEvent, refetchClock } = useTeam();

  const [clockInLoading, setClockInLoading] = useState(false);
  const [clockOutLoading, setClockOutLoading] = useState(false);
  const [clockPauseLoading, setClockPauseLoading] = useState(false);

  const isClockedIn = !!activeClockEvent;

  const clockIn = useCallback(async () => {
    setClockInLoading(true);
    try {
      await clockApi.start();
      await refetchClock();
    } finally {
      setClockInLoading(false);
    }
  }, [refetchClock]);

  const clockOut = useCallback(async () => {
    if (!activeClockEvent) return;
    setClockOutLoading(true);
    try {
      await clockApi.stop();
      await refetchClock();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to clock out. Please try again.');
    } finally {
      setClockOutLoading(false);
    }
  }, [activeClockEvent, refetchClock]);

  const pauseClock = useCallback(async () => {
    if (!activeClockEvent) return;
    setClockPauseLoading(true);
    try {
      await clockApi.pause();
      await refetchClock();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to pause clock. Please try again.');
    } finally {
      setClockPauseLoading(false);
    }
  }, [activeClockEvent, refetchClock]);

  const resumeClock = useCallback(async () => {
    if (!activeClockEvent) return;
    setClockPauseLoading(true);
    try {
      await clockApi.resume();
      await refetchClock();
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : 'Failed to resume clock. Please try again.',
      );
    } finally {
      setClockPauseLoading(false);
    }
  }, [activeClockEvent, refetchClock]);

  return {
    isClockedIn,
    clockIn,
    clockOut,
    pauseClock,
    resumeClock,
    clockInLoading,
    clockOutLoading,
    clockPauseLoading,
  };
}
