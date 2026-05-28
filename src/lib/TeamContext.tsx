/**
 * TeamContext — Shared selected-team state.
 *
 * Teams and clock events are fetched via REST from timecore.
 *
 * Provides:
 *   • teams            — all teams the user belongs to (REST)
 *   • teamsReady       — true once the first fetch completes
 *   • refetchTeams     — callable after mutations to refresh the list
 *   • selectedTeamId   — persisted in localStorage
 *   • activeClockEvent — the user's current open clock event (REST)
 *   • clockReady       — true once the first clock fetch completes
 *   • refetchClock     — callable after clock mutations to refresh
 *   • currentTime      — ticks every second for live timers
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { teamApi, clockApi, type Team, type ClockEvent } from './api';
import { useSession } from './useSession';

const TEAM_KEY = 'app:selectedTeamId';

function getUserTeamKey(userId: string): string {
  return `${TEAM_KEY}:${userId}`;
}

export interface TeamContextValue {
  teams: Team[];
  teamsReady: boolean;
  refetchTeams: () => void;
  selectedTeamId: string | null;
  selectedTeam: Team | null;
  setSelectedTeamId: (id: string) => void;
  isAdmin: boolean;
  activeClockEvent: ClockEvent | null;
  clockReady: boolean;
  refetchClock: () => void;
  currentTime: number;
}

const TeamCtx = createContext<TeamContextValue>({
  teams: [],
  teamsReady: false,
  refetchTeams: () => {},
  selectedTeamId: null,
  selectedTeam: null,
  setSelectedTeamId: () => {},
  isAdmin: false,
  activeClockEvent: null,
  clockReady: false,
  refetchClock: () => {},
  currentTime: Date.now(),
});

export const useTeam = () => useContext(TeamCtx);

export const TeamProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useSession();
  const userId = user?.id ?? null;

  // ── Teams via REST ──────────────────────────────────────────────────────────

  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsReady, setTeamsReady] = useState(false);

  const refetchTeams = useCallback(() => {
    teamApi
      .getTeams()
      .then(setTeams)
      .catch(() => {})
      .finally(() => setTeamsReady(true));
  }, []);

  useEffect(() => {
    if (!userId) return;
    // Ensure a personal workspace exists (idempotent), then load teams
    teamApi
      .ensurePersonal()
      .catch(() => {})
      .finally(() => refetchTeams());
  }, [userId, refetchTeams]);

  // Real-time WebSocket connection for team updates
  useEffect(() => {
    if (!userId) return;

    const ws = teamApi.openLiveStream();

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'snapshot') {
          // Initial snapshot: replace teams state
          const newTeams = data.teams as Team[];
          setTeams(newTeams);
          setTeamsReady(true);
        } else if (data.type === 'update') {
          // Real-time team update — upsert by id
          const updatedTeam = data.team as Team;
          setTeams((prev) => {
            const idx = prev.findIndex((t) => t.id === updatedTeam.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = updatedTeam;
              return copy;
            }
            return [...prev, updatedTeam];
          });
        } else if (data.type === 'delete') {
          // Team deleted — remove from state
          setTeams((prev) => prev.filter((t) => t.id !== data.teamId));
        }
      } catch (err) {
        console.warn('Failed to parse teams WebSocket message:', err);
      }
    };

    // Cleanup: close WebSocket when userId changes or component unmounts
    return () => {
      ws.close();
    };
  }, [userId]);

  // ── Selected team ───────────────────────────────────────────────────────────

  const [selectedTeamId, _setSelectedTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!userId) {
      _setSelectedTeamId(null);
      return;
    }

    // Backward compatibility: fall back to the legacy global key once.
    const scoped = localStorage.getItem(getUserTeamKey(userId));
    const legacy = localStorage.getItem(TEAM_KEY);
    _setSelectedTeamId(scoped ?? legacy);
  }, [userId]);

  const setSelectedTeamId = useCallback(
    (id: string) => {
      _setSelectedTeamId(id);
      if (!userId || typeof window === 'undefined') return;
      localStorage.setItem(getUserTeamKey(userId), id);
    },
    [userId],
  );

  // Ensure selected team belongs to the current user; otherwise pick first available.
  useEffect(() => {
    if (!userId || teams.length === 0) return;

    const hasSelected = selectedTeamId ? teams.some((team) => team.id === selectedTeamId) : false;

    if (!hasSelected) {
      setSelectedTeamId(teams[0].id);
    }
  }, [selectedTeamId, teams, setSelectedTeamId, userId]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  const isAdmin = useMemo(
    () => !!(userId && selectedTeam?.admins.includes(userId)),
    [userId, selectedTeam],
  );

  // ── Clock events via WebSocket (real-time) + REST fallback ─────────────────

  const [activeClockEvent, setActiveClockEvent] = useState<ClockEvent | null>(null);
  const [clockReady, setClockReady] = useState(false);

  const refetchClock = useCallback(async () => {
    if (!userId) {
      setActiveClockEvent(null);
      setClockReady(true);
      return;
    }
    try {
      const event = await clockApi.getActive();
      setActiveClockEvent(event);
    } catch {
      setActiveClockEvent(null);
    } finally {
      setClockReady(true);
    }
  }, [userId]);

  // Initial fetch (fallback if WebSocket connection fails)
  useEffect(() => {
    void refetchClock();
  }, [refetchClock]);

  // Real-time WebSocket connection for clock updates
  useEffect(() => {
    if (!userId) {
      return;
    }

    const ws = clockApi.openLiveStream();

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'snapshot') {
          // Initial snapshot: find the current user's active event from the array
          const userEvent =
            data.events?.find((e: ClockEvent) => e.userId === userId && !e.endTime) ?? null;
          setActiveClockEvent(userEvent);
          setClockReady(true);
        } else if (data.type === 'update') {
          // Real-time update: apply if it's for the current user
          const updatedEvent = data.event as ClockEvent | null;
          if (updatedEvent && updatedEvent.userId === userId) {
            setActiveClockEvent(updatedEvent);
          } else if (!updatedEvent) {
            // Clock out (event is null)
            setActiveClockEvent(null);
          }
        }
      } catch (err) {
        // Ignore malformed messages
        console.warn('Failed to parse clock WebSocket message:', err);
      }
    };

    // Cleanup: close WebSocket connection when component unmounts
    return () => {
      ws.close();
    };
  }, [userId]);

  // ── Live timer ──────────────────────────────────────────────────────────────

  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Context value ───────────────────────────────────────────────────────────

  const value = useMemo<TeamContextValue>(
    () => ({
      teams,
      teamsReady,
      refetchTeams,
      selectedTeamId,
      selectedTeam,
      setSelectedTeamId,
      isAdmin,
      activeClockEvent,
      clockReady,
      refetchClock,
      currentTime,
    }),
    [
      teams,
      teamsReady,
      refetchTeams,
      selectedTeamId,
      selectedTeam,
      setSelectedTeamId,
      isAdmin,
      activeClockEvent,
      clockReady,
      refetchClock,
      currentTime,
    ],
  );

  return <TeamCtx.Provider value={value}>{children}</TeamCtx.Provider>;
};
