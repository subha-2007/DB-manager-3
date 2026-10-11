import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ShieldAlert,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import {
  AttendanceRecord,
  ColumnDefinition,
  ShiftOverlapConflict,
  StaffRecord,
} from '../types/database';
import {
  formatShiftDuration,
  getShiftIntervalMinutes,
  validateAttendanceOverlaps,
} from '../utils/shiftValidation';

interface AttendanceFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingLog: AttendanceRecord | null;
  allLogs: AttendanceRecord[];
  staffList: StaffRecord[];
  tableColumns: ColumnDefinition[];
  onSave: (record: AttendanceRecord, isUpdate: boolean, hadConflictOverride: boolean) => void;
}

const STANDARD_WARDS = [
  'ICU-North (Pods A-D)',
  'ER-Trauma Bay 1',
  'ER-Acute Observation',
  'Cardiothoracic Step-Down',
  'OR Suite 3 & 4',
  'Perioperative PACU',
  'Central Pharmacy / ICU Sat',
  'Neonatal ICU (NICU)',
];

const CORE_COLUMN_NAMES = new Set([
  'id',
  'staff_id',
  'shift_date',
  'shift_start',
  'shift_end',
  'ward',
  'status',
  'notes',
]);

export const AttendanceFormModal: React.FC<AttendanceFormModalProps> = ({
  isOpen,
  onClose,
  editingLog,
  allLogs,
  staffList,
  tableColumns,
  onSave,
}) => {
  const isUpdate = Boolean(editingLog);

  const [id, setId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [shiftDate, setShiftDate] = useState('2026-10-08');
  const [shiftStart, setShiftStart] = useState('13:00');
  const [shiftEnd, setShiftEnd] = useState('21:00');
  const [ward, setWard] = useState(STANDARD_WARDS[0]);
  const [status, setStatus] = useState<AttendanceRecord['status']>('Scheduled');
  const [notes, setNotes] = useState('');
  const [allowOverride, setAllowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, any>>({});

  // Extra columns added via Admin DDL `ALTER TABLE attendance_logs ADD COLUMN ...`
  const extraColumns = useMemo(
    () => tableColumns.filter((c) => !CORE_COLUMN_NAMES.has(c.name)),
    [tableColumns]
  );

  useEffect(() => {
    if (!isOpen) return;
    if (editingLog) {
      setId(editingLog.id);
      setStaffId(editingLog.staff_id);
      setShiftDate(editingLog.shift_date);
      setShiftStart(editingLog.shift_start);
      setShiftEnd(editingLog.shift_end);
      setWard(editingLog.ward);
      setStatus(editingLog.status);
      setNotes(editingLog.notes || '');
      setAllowOverride(false);
      setOverrideReason(editingLog.override_reason || '');
      const extra: Record<string, any> = {};
      extraColumns.forEach((col) => {
        extra[col.name] = editingLog[col.name] ?? col.defaultValue ?? '';
      });
      setCustomFields(extra);
    } else {
      const nextNum =
        allLogs.reduce((max, r) => {
          const m = String(r.id).match(/ATT-(\d+)/i);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 408) + 1;
      setId(`ATT-${nextNum}`);
      setStaffId(staffList[0]?.id || 'STF-101');
      setShiftDate('2026-10-08');
      // Default to 13:00 - 21:00 so if STF-101 is selected, the user immediately sees the live overlap check in action!
      setShiftStart('13:00');
      setShiftEnd('21:00');
      setWard(STANDARD_WARDS[0]);
      setStatus('Scheduled');
      setNotes('Clinical ward coverage assignment');
      setAllowOverride(false);
      setOverrideReason('');
      const extra: Record<string, any> = {};
      extraColumns.forEach((col) => {
        extra[col.name] = col.defaultValue ?? (col.type === 'BOOLEAN' ? false : '');
      });
      setCustomFields(extra);
    }
  }, [isOpen, editingLog, allLogs, staffList, extraColumns]);

  // Real-time overlap validation
  const overlaps: ShiftOverlapConflict[] = useMemo(() => {
    return validateAttendanceOverlaps(
      {
        id: isUpdate ? id : undefined,
        staff_id: staffId,
        shift_date: shiftDate,
        shift_start: shiftStart,
        shift_end: shiftEnd,
      },
      allLogs,
      staffList
    );
  }, [isUpdate, id, staffId, shiftDate, shiftStart, shiftEnd, allLogs, staffList]);

  // Existing shifts for this staff member on this date (for the 24h visual timeline bar)
  const sameDayStaffShifts = useMemo(() => {
    return allLogs.filter(
      (l) =>
        String(l.staff_id) === String(staffId) &&
        String(l.shift_date).trim() === String(shiftDate).trim() &&
        (!isUpdate || String(l.id) !== String(id))
    );
  }, [allLogs, staffId, shiftDate, isUpdate, id]);

  const selectedStaff = useMemo(
    () => staffList.find((s) => s.id === staffId),
    [staffList, staffId]
  );

  if (!isOpen) return null;

  const hasConflict = overlaps.length > 0;
  const canSubmit = !hasConflict || (allowOverride && overrideReason.trim().length >= 4);

  const handleApplySuggestion = (conflict: ShiftOverlapConflict) => {
    setShiftStart(conflict.suggestedStart);
    setShiftEnd(conflict.suggestedEnd);
    setAllowOverride(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const finalStatus: AttendanceRecord['status'] = hasConflict
      ? 'Conflict Flagged'
      : status === 'Conflict Flagged'
      ? 'Scheduled'
      : status;

    const finalNotes =
      hasConflict && allowOverride && overrideReason.trim()
        ? `${notes ? notes + ' | ' : ''}[OVERRIDE: ${overrideReason.trim()}]`
        : notes;

    const payload: AttendanceRecord = {
      ...customFields,
      id: id.trim() || `ATT-${Date.now().toString().slice(-3)}`,
      staff_id: staffId,
      shift_date: shiftDate,
      shift_start: shiftStart,
      shift_end: shiftEnd,
      ward,
      status: finalStatus,
      notes: finalNotes,
    };

    onSave(payload, isUpdate, hasConflict && allowOverride);
    onClose();
  };

  const [candStartMin, candEndMin] = getShiftIntervalMinutes(shiftStart, shiftEnd);
  const candLeftPct = Math.max(0, Math.min(100, (candStartMin / 1440) * 100));
  const candWidthPct = Math.max(2, Math.min(100 - candLeftPct, ((candEndMin - candStartMin) / 1440) * 100));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-2xl overflow-hidden my-8">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {isUpdate ? `Update Attendance Log · ${id}` : 'Log Clinical Shift Attendance'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Real-time shift overlap detector validates staff availability before committing to{' '}
              <code className="font-mono text-slate-700">attendance_logs</code>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200/60 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Primary Fields Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Log ID (Primary Key)
              </label>
              <input
                type="text"
                value={id}
                disabled={isUpdate}
                onChange={(e) => setId(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-800 disabled:opacity-70 focus:outline-none focus:ring-2 focus:ring-teal-600"
                required
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Clinical Staff Member
              </label>
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name} ({s.id} · {s.role} · {s.department})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Date & Shift Time Window */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Shift Date
              </label>
              <input
                type="date"
                value={shiftDate}
                onChange={(e) => setShiftDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Shift Start (24h)
              </label>
              <input
                type="time"
                value={shiftStart}
                onChange={(e) => setShiftStart(e.target.value)}
                className={`w-full px-3 py-2 text-sm font-mono bg-white border rounded-lg focus:outline-none focus:ring-2 ${
                  hasConflict
                    ? 'border-red-500 text-red-900 focus:ring-red-600 bg-red-50/30'
                    : 'border-slate-300 text-slate-900 focus:ring-teal-600'
                }`}
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Shift End (24h)
              </label>
              <input
                type="time"
                value={shiftEnd}
                onChange={(e) => setShiftEnd(e.target.value)}
                className={`w-full px-3 py-2 text-sm font-mono bg-white border rounded-lg focus:outline-none focus:ring-2 ${
                  hasConflict
                    ? 'border-red-500 text-red-900 focus:ring-red-600 bg-red-50/30'
                    : 'border-slate-300 text-slate-900 focus:ring-teal-600'
                }`}
                required
              />
            </div>
          </div>

          {/* 24-Hour Visual Shift Timeline & Conflict Inspector */}
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-500" />
                24-Hour Roster Timeline for {selectedStaff?.full_name || staffId} on{' '}
                <span className="font-mono">{shiftDate}</span>
              </span>
              <span className="font-mono text-slate-600">
                Candidate Duration: {formatShiftDuration(shiftStart, shiftEnd)}
              </span>
            </div>

            {/* 24h ruler track */}
            <div className="relative h-10 bg-slate-200/80 rounded-md overflow-hidden border border-slate-300/80">
              {/* Hour grid lines */}
              {[0, 4, 8, 12, 16, 20].map((hr) => (
                <div
                  key={hr}
                  style={{ left: `${(hr / 24) * 100}%` }}
                  className="absolute top-0 bottom-0 border-l border-slate-300/70 text-[10px] font-mono text-slate-500 pl-1 pt-0.5 select-none"
                >
                  {String(hr).padStart(2, '0')}:00
                </div>
              ))}

              {/* Existing shifts on this date */}
              {sameDayStaffShifts.map((existing) => {
                const [sMin, eMin] = getShiftIntervalMinutes(
                  existing.shift_start,
                  existing.shift_end
                );
                const left = Math.max(0, Math.min(100, (sMin / 1440) * 100));
                const width = Math.max(2, Math.min(100 - left, ((eMin - sMin) / 1440) * 100));
                return (
                  <div
                    key={existing.id}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`Existing: ${existing.id} (${existing.shift_start}–${existing.shift_end})`}
                    className="absolute top-1.5 h-3.5 bg-slate-700 text-white text-[10px] font-mono px-1.5 rounded-xs flex items-center truncate opacity-90"
                  >
                    {existing.id}: {existing.shift_start}–{existing.shift_end}
                  </div>
                );
              })}

              {/* Proposed / Candidate shift */}
              <div
                style={{ left: `${candLeftPct}%`, width: `${candWidthPct}%` }}
                className={`absolute bottom-1 h-3.5 text-[10px] font-mono px-1.5 rounded-xs flex items-center truncate transition-all ${
                  hasConflict
                    ? 'bg-red-600 text-white ring-2 ring-red-400'
                    : 'bg-teal-600 text-white'
                }`}
              >
                {hasConflict ? 'CONFLICT' : 'PROPOSED'}: {shiftStart}–{shiftEnd}
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-slate-700 inline-block" />
                  Existing Shift ({sameDayStaffShifts.length})
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`w-2.5 h-2.5 rounded-xs inline-block ${
                      hasConflict ? 'bg-red-600' : 'bg-teal-600'
                    }`}
                  />
                  Candidate Shift ({shiftStart}–{shiftEnd})
                </span>
              </div>
              {!hasConflict && (
                <span className="text-emerald-700 font-medium inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  No overlapping shifts detected
                </span>
              )}
            </div>
          </div>

          {/* Real-Time Overlap Conflict Diagnostic Alert */}
          {hasConflict && (
            <div
              role="alert"
              className="p-4 rounded-lg bg-red-50 border border-red-300 text-red-950 space-y-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-red-900">
                    Overlapping Shift Detected ({overlaps.length}{' '}
                    {overlaps.length === 1 ? 'Conflict' : 'Conflicts'})
                  </h3>
                  <p className="text-xs text-red-800 mt-0.5">
                    {selectedStaff?.full_name || staffId} is already scheduled during the{' '}
                    <span className="font-mono font-semibold">
                      {shiftStart} – {shiftEnd}
                    </span>{' '}
                    window on <span className="font-mono font-semibold">{shiftDate}</span>.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {overlaps.map((conflict) => (
                  <div
                    key={conflict.conflictingLog.id}
                    className="p-3 rounded-md bg-white border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-0.5 text-xs">
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        <span className="font-mono text-red-700">
                          {conflict.conflictingLog.id}
                        </span>
                        <span>·</span>
                        <span>{conflict.conflictingLog.ward}</span>
                      </div>
                      <div className="text-slate-600 font-mono">
                        Scheduled: {conflict.conflictingLog.shift_start} –{' '}
                        {conflict.conflictingLog.shift_end} ·{' '}
                        <span className="text-red-700 font-semibold">
                          Overlap Window: {conflict.overlapWindowStart} –{' '}
                          {conflict.overlapWindowEnd} ({conflict.overlapMinutes} mins)
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleApplySuggestion(conflict)}
                      className="px-3 py-1.5 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1.5 shrink-0"
                    >
                      <span>
                        Auto-Adjust to {conflict.suggestedStart}–{conflict.suggestedEnd}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Clinical Supervisor Override Option */}
              <div className="pt-2 border-t border-red-200/80 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium text-red-900 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allowOverride}
                    onChange={(e) => setAllowOverride(e.target.checked)}
                    className="rounded border-red-400 text-red-600 focus:ring-red-600"
                  />
                  <span>
                    Override conflict block with Clinical Supervisor authorization (marks record as
                    Conflict Flagged)
                  </span>
                </label>

                {allowOverride && (
                  <div>
                    <input
                      type="text"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Enter mandatory clinical justification (e.g., Code Blue cross-coverage)..."
                      className="w-full px-3 py-1.5 text-xs bg-white border border-red-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ward & Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Assigned Hospital Ward / Unit
              </label>
              <input
                type="text"
                list="ward-options"
                value={ward}
                onChange={(e) => setWard(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                required
              />
              <datalist id="ward-options">
                {STANDARD_WARDS.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Attendance Status
              </label>
              <select
                value={hasConflict ? 'Conflict Flagged' : status}
                disabled={hasConflict}
                onChange={(e) =>
                  setStatus(e.target.value as AttendanceRecord['status'])
                }
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 disabled:bg-red-50 disabled:text-red-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                <option value="Scheduled">Scheduled</option>
                <option value="Clocked In">Clocked In</option>
                <option value="Completed">Completed</option>
                <option value="Conflict Flagged">Conflict Flagged</option>
              </select>
            </div>
          </div>

          {/* Dynamic DDL Columns (if admin added columns via ALTER TABLE) */}
          {extraColumns.length > 0 && (
            <div className="p-3.5 rounded-lg bg-teal-50/50 border border-teal-200 space-y-3">
              <div className="text-xs font-semibold text-teal-900">
                Dynamic Schema Columns (Added via Admin DDL Workbench)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {extraColumns.map((col) => (
                  <div key={col.name}>
                    <label className="block text-xs font-mono text-slate-700 mb-1">
                      {col.name} ({col.type})
                    </label>
                    {col.type === 'BOOLEAN' ? (
                      <select
                        value={String(Boolean(customFields[col.name]))}
                        onChange={(e) =>
                          setCustomFields((prev) => ({
                            ...prev,
                            [col.name]: e.target.value === 'true',
                          }))
                        }
                        className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : (
                      <input
                        type={col.type === 'INTEGER' ? 'number' : 'text'}
                        value={customFields[col.name] ?? ''}
                        onChange={(e) =>
                          setCustomFields((prev) => ({
                            ...prev,
                            [col.name]:
                              col.type === 'INTEGER'
                                ? Number(e.target.value)
                                : e.target.value,
                          }))
                        }
                        className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shift Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Clinical Handover & Shift Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Document clinical coverage details, pod assignment, or consult handover..."
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-200">
            <div className="text-xs text-slate-500">
              {hasConflict && !canSubmit ? (
                <span className="text-red-700 font-medium inline-flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  Resolve shift overlap or authorize supervisor override to save
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-slate-600">
                  <UserCheck className="w-3.5 h-3.5 text-teal-700" />
                  Ready to commit to live database
                </span>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={`px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors whitespace-nowrap ${
                  !canSubmit
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                    : hasConflict
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-teal-700 hover:bg-teal-800'
                }`}
              >
                {hasConflict
                  ? 'Commit with Conflict Override'
                  : isUpdate
                  ? 'Save Shift Changes'
                  : 'Create Attendance Log'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
