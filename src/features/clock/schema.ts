import { z } from 'zod';

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const clockEventStartSchema = z.object({});

export const clockEventStopSchema = z.object({
  youtubeShortLink: z.string().optional(),
});

export const updateClockEventTimesSchema = z.object({
  clockEventId: z.string().min(1),
  startTime: z.number().optional(),
  endTime: z.number().nullable().optional(),
});

export const updateYoutubeLinkSchema = z.object({
  clockEventId: z.string().min(1),
  youtubeShortLink: z.string(),
});

export const timesheetQuerySchema = z.object({
  userId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
});

export type ClockEventStartInput = z.infer<typeof clockEventStartSchema>;
export type ClockEventStopInput = z.infer<typeof clockEventStopSchema>;
export type UpdateClockEventTimesInput = z.infer<typeof updateClockEventTimesSchema>;
export type TimesheetQueryInput = z.infer<typeof timesheetQuerySchema>;

// ─── Document types ───────────────────────────────────────────────────────────

export interface ClockEventDoc {
  _id?: string;
  userId: string;
  teamId?: string;
  startTime: number;
  accumulatedTime: number;
  endTime: number | null;
  youtubeShortLink?: string;
}

export interface SessionDoc {
  _id?: string;
  userId: string;
  teamId?: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
}
