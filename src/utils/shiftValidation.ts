import { AttendanceRecord, ShiftOverlapConflict, StaffRecord } from '../types/database';

/**
 * Converts "HH:mm" time string into minutes since 00:00.
 */
export function parseTimeToMinutes(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const clean = timeStr.trim();
  const parts = clean.split(':');
  if (parts.length < 2) return 0;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return 0;
  return hours * 60 + minutes;
}

/**
 * Converts minutes since 00:00 back to "HH:mm" format (wrapping 24h if needed).
 */
export function formatMinutesToTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Returns normalized [startMin, endMin] where overnight shifts (end <= start) extend past 1440.
 */
export function getShiftIntervalMinutes(startStr: string, endStr: string): [number, number] {
  const start = parseTimeToMinutes(startStr);
  let end = parseTimeToMinutes(endStr);
  if (end <= start) {
    end += 1440; // Overnight shift spanning midnight
  }
  return [start, end];
}

/**
 * Calculates shift duration formatted as "Xh Ym"
 */
export function formatShiftDuration(startStr: string, endStr: string): string {
  const [start, end] = getShiftIntervalMinutes(startStr, endStr);
  const diff = Math.max(0, end - start);
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h 00m`;
}

/**
 * Validates a candidate attendance log (create or update) against all existing attendance logs
 * to detect overlapping shifts for the same staff member on the same date.
 */
export function validateAttendanceOverlaps(
  candidate: {
    id?: string;
    staff_id: string;
    shift_date: string;
    shift_start: string;
    shift_end: string;
  },
  allLogs: AttendanceRecord[],
  staffList: StaffRecord[] = []
): ShiftOverlapConflict[] {
  if (!candidate.staff_id || !candidate.shift_date || !candidate.shift_start || !candidate.shift_end) {
    return [];
  }

  const [candStart, candEnd] = getShiftIntervalMinutes(candidate.shift_start, candidate.shift_end);
  const duration = candEnd - candStart;
  if (duration <= 0) return [];

  const staffMember = staffList.find((s) => s.id === candidate.staff_id);
  const conflicts: ShiftOverlapConflict[] = [];

  for (const log of allLogs) {
    // Skip self when updating an existing attendance record
    if (candidate.id && String(log.id) === String(candidate.id)) {
      continue;
    }

    if (String(log.staff_id) !== String(candidate.staff_id)) {
      continue;
    }

    if (String(log.shift_date).trim() !== String(candidate.shift_date).trim()) {
      continue;
    }

    const [existStart, existEnd] = getShiftIntervalMinutes(log.shift_start, log.shift_end);

    // Overlap condition: max(start1, start2) < min(end1, end2)
    const overlapStart = Math.max(candStart, existStart);
    const overlapEnd = Math.min(candEnd, existEnd);

    if (overlapStart < overlapEnd) {
      const overlapMinutes = overlapEnd - overlapStart;
      // Suggest shifting candidate to immediately after existing shift ends
      const suggestedStartMin = existEnd;
      const suggestedEndMin = existEnd + duration;

      conflicts.push({
        conflictingLog: log,
        staffMember,
        overlapMinutes,
        overlapWindowStart: formatMinutesToTime(overlapStart),
        overlapWindowEnd: formatMinutesToTime(overlapEnd),
        suggestedStart: formatMinutesToTime(suggestedStartMin),
        suggestedEnd: formatMinutesToTime(suggestedEndMin),
      });
    }
  }

  return conflicts;
}

/**
 * Builds a lookup map of all existing attendance log IDs that currently have overlaps
 * with at least one other shift for the same staff member on the same date.
 */
export function buildDatabaseConflictMap(
  allLogs: AttendanceRecord[],
  staffList: StaffRecord[] = []
): Record<string, ShiftOverlapConflict[]> {
  const map: Record<string, ShiftOverlapConflict[]> = {};
  for (const log of allLogs) {
    const conflicts = validateAttendanceOverlaps(
      {
        id: log.id,
        staff_id: log.staff_id,
        shift_date: log.shift_date,
        shift_start: log.shift_start,
        shift_end: log.shift_end,
      },
      allLogs,
      staffList
    );
    if (conflicts.length > 0) {
      map[log.id] = conflicts;
    }
  }
  return map;
}
