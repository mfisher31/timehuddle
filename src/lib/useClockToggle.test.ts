import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTeam } from './TeamContext';
import { clockApi } from './api';
import { useClockToggle } from './useClockToggle';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./TeamContext', () => ({ useTeam: vi.fn() }));

vi.mock('./api', () => ({
  clockApi: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

const mockUseTeam = vi.mocked(useTeam);
const mockStart = vi.mocked(clockApi.start);
const mockStop = vi.mocked(clockApi.stop);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockRefetchClock = vi.fn();

function setupTeam(
  opts: {
    activeClockEvent?: { id: string; teamId?: string } | null;
    selectedTeamId?: string | null;
  } = {},
) {
  mockUseTeam.mockReturnValue({
    teams: [],
    teamsReady: true,
    refetchTeams: vi.fn(),
    selectedTeamId: 'selectedTeamId' in opts ? (opts.selectedTeamId ?? null) : 'team1',
    selectedTeam: null,
    setSelectedTeamId: vi.fn(),
    isAdmin: false,
    activeClockEvent: (opts.activeClockEvent ?? null) as any,
    clockReady: true,
    refetchClock: mockRefetchClock,
    currentTime: Date.now(),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useClockToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.alert = vi.fn();
    mockStart.mockResolvedValue({ id: 'evt1' } as any);
    mockStop.mockResolvedValue({ id: 'evt1' } as any);
    mockRefetchClock.mockResolvedValue(undefined);
  });

  // ── isClockedIn ─────────────────────────────────────────────────────────────

  describe('isClockedIn', () => {
    it('is false when there is no active clock event', () => {
      setupTeam({ activeClockEvent: null });
      const { result } = renderHook(() => useClockToggle());
      expect(result.current.isClockedIn).toBe(false);
    });

    it('is true when there is an active clock event', () => {
      setupTeam({ activeClockEvent: { id: 'evt1', teamId: 'team1' } });
      const { result } = renderHook(() => useClockToggle());
      expect(result.current.isClockedIn).toBe(true);
    });
  });

  // ── clockIn() ───────────────────────────────────────────────────────────────

  describe('clockIn()', () => {
    it('calls clockApi.start with selectedTeamId then refetchClock', async () => {
      setupTeam({ activeClockEvent: null, selectedTeamId: 'team-abc' });
      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockIn());

      expect(mockStart).toHaveBeenCalledWith();
      expect(mockRefetchClock).toHaveBeenCalledOnce();
    });

    it('does not require selectedTeamId', async () => {
      setupTeam({ activeClockEvent: null, selectedTeamId: null });
      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockIn());

      expect(mockStart).toHaveBeenCalledWith();
      expect(mockRefetchClock).toHaveBeenCalledOnce();
    });

    it('sets clockInLoading=true during the call and false after', async () => {
      setupTeam({ selectedTeamId: 'team1' });
      let resolveStart!: (value?: any) => void;
      mockStart.mockReturnValue(
        new Promise<any>((res) => {
          resolveStart = res;
        }),
      );

      const { result } = renderHook(() => useClockToggle());

      act(() => {
        void result.current.clockIn();
      });
      expect(result.current.clockInLoading).toBe(true);

      await act(async () => {
        resolveStart();
      });
      expect(result.current.clockInLoading).toBe(false);
    });
  });

  // ── clockOut() ──────────────────────────────────────────────────────────────

  describe('clockOut()', () => {
    it('stops when there is an active event', async () => {
      setupTeam({
        activeClockEvent: { id: 'evt1', teamId: 'team-from-event' },
        selectedTeamId: 'team-from-ui',
      });
      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockOut());

      expect(mockStop).toHaveBeenCalledWith();
      expect(mockRefetchClock).toHaveBeenCalledOnce();
    });

    it('does nothing when there is no active event', async () => {
      setupTeam({ activeClockEvent: null, selectedTeamId: 'team-fallback' });
      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockOut());

      expect(mockStop).not.toHaveBeenCalled();
    });

    it('does nothing when there is no active event and no selected team', async () => {
      setupTeam({ activeClockEvent: null, selectedTeamId: null });
      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockOut());

      expect(mockStop).not.toHaveBeenCalled();
      expect(mockRefetchClock).not.toHaveBeenCalled();
    });

    it('shows window.alert and does not rethrow on API error', async () => {
      setupTeam({ activeClockEvent: { id: 'evt1', teamId: 'team1' } });
      mockStop.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useClockToggle());

      await act(() => result.current.clockOut());

      expect(window.alert).toHaveBeenCalledWith('Network error');
      expect(result.current.clockOutLoading).toBe(false);
    });

    it('sets clockOutLoading=true during the call and false after', async () => {
      setupTeam({ activeClockEvent: { id: 'evt1', teamId: 'team1' } });
      let resolveStop!: (value?: any) => void;
      mockStop.mockReturnValue(
        new Promise<any>((res) => {
          resolveStop = res;
        }),
      );

      const { result } = renderHook(() => useClockToggle());

      act(() => {
        void result.current.clockOut();
      });
      expect(result.current.clockOutLoading).toBe(true);

      await act(async () => {
        resolveStop();
      });
      expect(result.current.clockOutLoading).toBe(false);
    });
  });
});
