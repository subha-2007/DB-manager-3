import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Database,
  Edit3,
  Plus,
  Search,
  Shield,
  Terminal,
  Trash2,
  UserCheck,
  Wrench,
} from 'lucide-react';
import { AttendanceFormModal } from './components/AttendanceFormModal';
import { SqlWorkbenchPane } from './components/SqlWorkbenchPane';
import { INITIAL_DATABASE_TABLES } from './data/initialDatabase';
import {
  AttendanceRecord,
  RbacPolicyRecord,
  RoleType,
  ShiftOverlapConflict,
  SqlExecutionResult,
  StaffRecord,
  TableSchema,
} from './types/database';
import {
  buildDatabaseConflictMap,
  formatShiftDuration,
  getShiftIntervalMinutes,
} from './utils/shiftValidation';
import { checkRbacPermission, executeSqlCommand } from './utils/sqlEngine';

const STORAGE_KEY = 'aegis_clinical_hospital_db_v1';

export default function App() {
  // Persistent live database state
  const [tables, setTables] = useState<Record<string, TableSchema>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.attendance_logs && parsed.staff) {
          return parsed;
        }
      }
    } catch {
      // ignore storage error
    }
    return JSON.parse(JSON.stringify(INITIAL_DATABASE_TABLES));
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tables));
    } catch {
      // ignore quota error
    }
  }, [tables]);

  // Active Navigation & RBAC Role
  const [activeNav, setActiveNav] = useState<'attendance' | 'explorer' | 'rbac' | 'timeline'>(
    'attendance'
  );
  const [activeRole, setActiveRole] = useState<RoleType>('SYS_ADMIN');

  // Split-Screen Admin SQL DDL/DML Workbench visibility & width state
  const [isSqlPaneOpen, setIsSqlPaneOpen] = useState<boolean>(true);
  const [isSqlPaneExpanded, setIsSqlPaneExpanded] = useState<boolean>(false);
  const [sqlHistory, setSqlHistory] = useState<SqlExecutionResult[]>([]);

  // Attendance filtering & modal state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CONFLICTS' | 'CLOCKED_IN' | 'SCHEDULED'>(
    'ALL'
  );
  const [selectedStaffFilter, setSelectedStaffFilter] = useState<string>('ALL');
  const [isAttendanceModalOpen, setIsAttendanceModalOpen] = useState(false);
  const [editingAttendance, setEditingAttendance] = useState<AttendanceRecord | null>(null);

  // Database Explorer active table
  const [explorerTable, setExplorerTable] = useState<string>('attendance_logs');

  // Toast / Status feedback banner
  const [toastBanner, setToastBanner] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);

  const showNotice = (type: 'success' | 'warning' | 'error', message: string) => {
    setToastBanner({ type, message });
  };

  // Derived data from live database tables
  const staffList = useMemo(
    () => (tables.staff?.rows || []) as StaffRecord[],
    [tables.staff]
  );

  const attendanceLogs = useMemo(
    () => (tables.attendance_logs?.rows || []) as AttendanceRecord[],
    [tables.attendance_logs]
  );

  const attendanceColumns = useMemo(
    () => tables.attendance_logs?.columns || [],
    [tables.attendance_logs]
  );

  const extraAttendanceColumns = useMemo(() => {
    const core = new Set([
      'id',
      'staff_id',
      'shift_date',
      'shift_start',
      'shift_end',
      'ward',
      'status',
      'notes',
    ]);
    return attendanceColumns.filter((c) => !core.has(c.name));
  }, [attendanceColumns]);

  // Real-time overlap conflict map across the entire attendance_logs table
  const conflictMap: Record<string, ShiftOverlapConflict[]> = useMemo(
    () => buildDatabaseConflictMap(attendanceLogs, staffList),
    [attendanceLogs, staffList]
  );

  const totalConflictRows = Object.keys(conflictMap).length;

  const staffLookup = useMemo(() => {
    const map: Record<string, StaffRecord> = {};
    staffList.forEach((s) => {
      map[s.id] = s;
    });
    return map;
  }, [staffList]);

  // Filtered attendance logs
  const filteredAttendance = useMemo(() => {
    return attendanceLogs.filter((log) => {
      const hasOverlap = Boolean(conflictMap[log.id]?.length);
      if (statusFilter === 'CONFLICTS' && !hasOverlap && log.status !== 'Conflict Flagged') {
        return false;
      }
      if (statusFilter === 'CLOCKED_IN' && log.status !== 'Clocked In') {
        return false;
      }
      if (statusFilter === 'SCHEDULED' && log.status !== 'Scheduled') {
        return false;
      }
      if (selectedStaffFilter !== 'ALL' && log.staff_id !== selectedStaffFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const staff = staffLookup[log.staff_id];
        const staffName = staff?.full_name?.toLowerCase() || '';
        const staffDept = staff?.department?.toLowerCase() || '';
        return (
          String(log.id).toLowerCase().includes(q) ||
          String(log.staff_id).toLowerCase().includes(q) ||
          staffName.includes(q) ||
          staffDept.includes(q) ||
          String(log.ward).toLowerCase().includes(q) ||
          String(log.notes || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [attendanceLogs, conflictMap, statusFilter, selectedStaffFilter, searchQuery, staffLookup]);

  // Execute raw DDL / DML / DQL command from the SQL Workbench or UI actions
  const handleExecuteSql = (rawSql: string): SqlExecutionResult => {
    const { nextTables, result } = executeSqlCommand(tables, rawSql, activeRole);
    setTables(nextTables);
    setSqlHistory((prev) => [result, ...prev]);

    // If a table was created via DDL, select it in the explorer if on explorer tab
    if (
      result.status === 'SUCCESS' &&
      result.operation === 'CREATE TABLE' &&
      result.targetTable &&
      nextTables[result.targetTable]
    ) {
      setExplorerTable(result.targetTable);
    }

    // If current explorerTable was dropped, fallback to attendance_logs
    if (!nextTables[explorerTable]) {
      setExplorerTable('attendance_logs');
    }

    if (result.status === 'SUCCESS') {
      if (result.overlapWarnings && result.overlapWarnings.length > 0) {
        showNotice('warning', result.overlapWarnings[0]);
      } else {
        showNotice('success', result.message);
      }
    } else {
      showNotice('error', result.message);
    }

    return result;
  };

  // Create or Update Attendance Log from Modal (with live sync to database & SQL history log)
  const handleSaveAttendanceLog = (
    record: AttendanceRecord,
    isUpdate: boolean,
    hadConflictOverride: boolean
  ) => {
    const perm = checkRbacPermission(
      tables,
      activeRole,
      isUpdate ? 'UPDATE' : 'INSERT',
      'attendance_logs'
    );
    if (!perm.allowed) {
      showNotice('error', perm.reason);
      return;
    }

    const nextTables: Record<string, TableSchema> = JSON.parse(JSON.stringify(tables));
    const logRows = nextTables.attendance_logs.rows as AttendanceRecord[];

    if (isUpdate) {
      const idx = logRows.findIndex((r) => String(r.id) === String(record.id));
      if (idx !== -1) {
        logRows[idx] = { ...logRows[idx], ...record };
      }
    } else {
      logRows.unshift(record);
    }

    // Re-evaluate all attendance_logs statuses so resolved conflicts clear automatically
    const updatedConflictMap = buildDatabaseConflictMap(logRows, staffList);
    logRows.forEach((row) => {
      if (updatedConflictMap[row.id]?.length) {
        row.status = 'Conflict Flagged';
      } else if (row.status === 'Conflict Flagged') {
        row.status = 'Scheduled';
      }
    });

    setTables(nextTables);

    // Record equivalent DML statement in SQL Workbench Audit Log for full transparency
    const generatedSql = isUpdate
      ? `UPDATE attendance_logs SET staff_id = '${record.staff_id}', shift_date = '${record.shift_date}', shift_start = '${record.shift_start}', shift_end = '${record.shift_end}', ward = '${record.ward}', status = '${record.status}' WHERE id = '${record.id}';`
      : `INSERT INTO attendance_logs (id, staff_id, shift_date, shift_start, shift_end, ward, status, notes) VALUES ('${record.id}', '${record.staff_id}', '${record.shift_date}', '${record.shift_start}', '${record.shift_end}', '${record.ward}', '${record.status}', '${(record.notes || '').replace(/'/g, "''")}');`;

    const auditEntry: SqlExecutionResult = {
      id: `UI-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      actorRole: activeRole,
      commandType: 'DML',
      operation: isUpdate ? 'UPDATE (UI Form)' : 'INSERT (UI Form)',
      targetTable: 'attendance_logs',
      rawSql: generatedSql,
      status: 'SUCCESS',
      message: isUpdate
        ? `Updated attendance record '${record.id}' via Shift Roster Form.`
        : `Inserted new attendance record '${record.id}' via Shift Roster Form.`,
      affectedRows: 1,
      executionMs: 1.2,
      overlapWarnings: hadConflictOverride
        ? [
            `Supervisor Override committed on '${record.id}': Shift overlaps existing assignment on ${record.shift_date}.`,
          ]
        : undefined,
    };

    setSqlHistory((prev) => [auditEntry, ...prev]);
    showNotice(
      hadConflictOverride ? 'warning' : 'success',
      hadConflictOverride
        ? `Saved ${record.id} with Clinical Supervisor Override (Conflict Flagged in DB).`
        : `${isUpdate ? 'Updated' : 'Created'} attendance log ${record.id} (${record.shift_start}–${record.shift_end}) with zero shift conflicts.`
    );
  };

  // Quick 1-click Auto-Resolve overlap directly from the table row
  const handleQuickResolveConflict = (log: AttendanceRecord, conflict: ShiftOverlapConflict) => {
    const sql = `UPDATE attendance_logs SET shift_start = '${conflict.suggestedStart}', shift_end = '${conflict.suggestedEnd}', notes = 'Auto-adjusted window to resolve overlap with ${conflict.conflictingLog.id}' WHERE id = '${log.id}';`;
    handleExecuteSql(sql);
  };

  // Delete attendance log row
  const handleDeleteAttendanceLog = (id: string) => {
    handleExecuteSql(`DELETE FROM attendance_logs WHERE id = '${id}';`);
  };

  // Reset entire database to initial seed state
  const handleResetDatabase = () => {
    const fresh = JSON.parse(JSON.stringify(INITIAL_DATABASE_TABLES));
    setTables(fresh);
    setExplorerTable('attendance_logs');
    setSqlHistory([]);
    showNotice('success', 'Hospital database reset to baseline schema and seed records.');
  };

  // Toggle RBAC permission boolean in rbac_policies table
  const handleToggleRbacPolicy = (
    policyId: string,
    field: 'can_select' | 'can_insert' | 'can_update' | 'can_delete' | 'can_ddl',
    currentVal: boolean
  ) => {
    if (activeRole !== 'SYS_ADMIN') {
      showNotice(
        'error',
        `RBAC Policy Violation: Only SYS_ADMIN can modify rbac_policies (Current role: ${activeRole}).`
      );
      return;
    }
    handleExecuteSql(
      `UPDATE rbac_policies SET ${field} = ${!currentVal} WHERE id = '${policyId}';`
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: Zone 1 (Single wordmark) — Zone 2 (4 nav links) — Zone 3 (2 primary actions) */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-white border-b border-slate-200 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('attendance');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap"
        >
          Aegis Clinical
        </a>

        {/* Zone 2: 4 clean text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setActiveNav('attendance')}
            className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
              activeNav === 'attendance'
                ? 'border-teal-600 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Attendance & Shifts
          </button>
          <button
            type="button"
            onClick={() => setActiveNav('timeline')}
            className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
              activeNav === 'timeline'
                ? 'border-teal-600 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Overlap Timeline
          </button>
          <button
            type="button"
            onClick={() => setActiveNav('explorer')}
            className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
              activeNav === 'explorer'
                ? 'border-teal-600 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Database Explorer
          </button>
          <button
            type="button"
            onClick={() => setActiveNav('rbac')}
            className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
              activeNav === 'rbac'
                ? 'border-teal-600 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            RBAC Policies
          </button>
        </nav>

        {/* Zone 3: 2 primary actions */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              setEditingAttendance(null);
              setIsAttendanceModalOpen(true);
            }}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Log Shift Attendance</span>
          </button>

          <button
            type="button"
            onClick={() => setIsSqlPaneOpen((v) => !v)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              isSqlPaneOpen
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100'
            }`}
          >
            <Terminal className="w-3.5 h-3.5 text-teal-400" />
            <span>{isSqlPaneOpen ? 'Hide DDL/DML Pane' : 'Open DDL/DML Pane'}</span>
          </button>
        </div>
      </header>

      {/* Main Split Workspace Container */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left / Primary Clinical Database Viewport */}
        <main
          className={`flex-1 overflow-y-auto p-6 space-y-6 transition-all ${
            isSqlPaneOpen
              ? isSqlPaneExpanded
                ? 'lg:w-5/12'
                : 'lg:w-7/12 xl:w-8/12'
              : 'w-full max-w-[1440px] mx-auto'
          }`}
        >
          {/* Context Sub-Bar: Active RBAC Role Switcher & Live DB Telemetry */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                Hospital Attendance & Relational RBAC Console
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 tabular-nums">
                <span>Active Relations: {Object.keys(tables).length} tables</span>
                <span aria-hidden="true">·</span>
                <span>Staff Roster: {staffList.length} personnel</span>
                <span aria-hidden="true">·</span>
                <span>Attendance Logs: {attendanceLogs.length} shifts</span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    totalConflictRows > 0
                      ? 'text-red-700 font-semibold'
                      : 'text-emerald-700 font-medium'
                  }
                >
                  Overlapping Shift Conflicts: {totalConflictRows}
                </span>
              </div>
            </div>

            {/* Interactive RBAC Role Switcher (Segmented Control) */}
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <span className="text-xs font-medium text-slate-500 whitespace-nowrap">
                Simulate RBAC Role:
              </span>
              <div className="flex items-center gap-1 p-1 bg-slate-200/80 rounded-lg">
                {(
                  ['SYS_ADMIN', 'CHARGE_NURSE', 'ATTENDING_MD', 'AUDITOR'] as RoleType[]
                ).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setActiveRole(role)}
                    className={`px-2.5 py-1 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap ${
                      activeRole === role
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Live Operation Notification Banner */}
          {toastBanner && (
            <div
              className={`p-3.5 rounded-lg border flex items-center justify-between gap-3 text-xs ${
                toastBanner.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : toastBanner.type === 'warning'
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : 'bg-red-50 border-red-300 text-red-950'
              }`}
            >
              <div className="flex items-center gap-2">
                {toastBanner.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                )}
                <span className="font-medium">{toastBanner.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setToastBanner(null)}
                className="text-xs underline opacity-75 hover:opacity-100 whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Active Shift Overlap Diagnostic Callout (when overlapping shifts exist in DB) */}
          {totalConflictRows > 0 && (
            <div className="p-4 rounded-xl bg-red-50/90 border border-red-200 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-sm font-semibold text-red-950">
                      Shift Overlap Validation Alert: {totalConflictRows} Attendance{' '}
                      {totalConflictRows === 1 ? 'Record Has' : 'Records Have'} Overlapping
                      Schedules
                    </h2>
                    <p className="text-xs text-red-800 mt-0.5">
                      Overlapping shifts for the same staff member on the same date are highlighted
                      below. You can auto-adjust shift windows in 1 click, edit via the modal, or
                      run an <code className="font-mono">UPDATE</code> /{' '}
                      <code className="font-mono">DELETE</code> statement in the Admin DDL & DML
                      Workbench.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setActiveNav('attendance');
                    setStatusFilter(statusFilter === 'CONFLICTS' ? 'ALL' : 'CONFLICTS');
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-red-700 hover:bg-red-800 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
                >
                  {statusFilter === 'CONFLICTS'
                    ? 'Show All Shifts'
                    : `Filter ${totalConflictRows} Overlapping Shifts`}
                </button>
              </div>
            </div>
          )}

          {/* VIEW 1: ATTENDANCE & SHIFTS LOGS WITH REAL-TIME OVERLAP HIGHLIGHTING */}
          {activeNav === 'attendance' && (
            <section className="space-y-4">
              {/* Filter & Search Bar */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                {/* Segmented Status Filter */}
                <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start">
                  <button
                    type="button"
                    onClick={() => setStatusFilter('ALL')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      statusFilter === 'ALL'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All Shifts ({attendanceLogs.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter('CONFLICTS')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
                      statusFilter === 'CONFLICTS'
                        ? 'bg-red-600 text-white shadow-xs'
                        : 'text-red-700 hover:bg-red-100/60'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Overlapping Conflicts ({totalConflictRows})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter('CLOCKED_IN')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      statusFilter === 'CLOCKED_IN'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Clocked In
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter('SCHEDULED')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      statusFilter === 'SCHEDULED'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Scheduled
                  </button>
                </div>

                {/* Staff Selector & Search Input */}
                <div className="flex items-center gap-2.5">
                  <select
                    value={selectedStaffFilter}
                    onChange={(e) => setSelectedStaffFilter(e.target.value)}
                    aria-label="Filter by staff member"
                    className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="ALL">All Clinical Personnel</option>
                    {staffList.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.full_name} ({s.id})
                      </option>
                    ))}
                  </select>

                  <div className="relative flex-1 sm:w-60">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search log ID, staff, ward..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                </div>
              </div>

              {/* High-Density Attendance Logs Data Grid */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                        <th className="py-3 px-4">Log ID</th>
                        <th className="py-3 px-4">Staff Member</th>
                        <th className="py-3 px-4">Date & Shift Window</th>
                        <th className="py-3 px-4">Assigned Ward</th>
                        <th className="py-3 px-4">Overlap Validation & Status</th>
                        {extraAttendanceColumns.map((col) => (
                          <th key={col.name} className="py-3 px-4 font-mono text-teal-700">
                            {col.name}
                          </th>
                        ))}
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-xs">
                      {filteredAttendance.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6 + extraAttendanceColumns.length}
                            className="py-10 px-4 text-center text-slate-500 space-y-2"
                          >
                            <div className="font-medium text-slate-700">
                              No attendance logs match the current filter criteria
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setStatusFilter('ALL');
                                setSelectedStaffFilter('ALL');
                                setSearchQuery('');
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-teal-700 hover:underline"
                            >
                              Reset Filters
                            </button>
                          </td>
                        </tr>
                      ) : (
                        filteredAttendance.map((log) => {
                          const staff = staffLookup[log.staff_id];
                          const rowConflicts = conflictMap[log.id] || [];
                          const hasConflict = rowConflicts.length > 0;

                          return (
                            <tr
                              key={log.id}
                              className={`transition-colors ${
                                hasConflict
                                  ? 'bg-red-50/70 hover:bg-red-50'
                                  : 'hover:bg-slate-50/90'
                              }`}
                            >
                              {/* Log ID */}
                              <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap align-top">
                                <div className="flex items-center gap-1.5">
                                  {hasConflict && (
                                    <AlertTriangle
                                      className="w-3.5 h-3.5 text-red-600 shrink-0"
                                      title="Overlapping shift conflict detected"
                                    />
                                  )}
                                  <span>{log.id}</span>
                                </div>
                              </td>

                              {/* Staff Member */}
                              <td className="py-3 px-4 align-top">
                                <div className="font-semibold text-slate-900">
                                  {staff ? staff.full_name : log.staff_id}
                                </div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  <span className="font-mono">{log.staff_id}</span>
                                  {staff && (
                                    <>
                                      <span aria-hidden="true"> · </span>
                                      <span>{staff.role}</span>
                                      <span aria-hidden="true"> · </span>
                                      <span>{staff.department}</span>
                                    </>
                                  )}
                                </div>
                              </td>

                              {/* Date & Shift Window */}
                              <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap align-top">
                                <div
                                  className={`font-semibold ${
                                    hasConflict ? 'text-red-800' : 'text-slate-900'
                                  }`}
                                >
                                  {log.shift_start} – {log.shift_end}{' '}
                                  <span className="text-[11px] font-normal text-slate-500">
                                    ({formatShiftDuration(log.shift_start, log.shift_end)})
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  {log.shift_date}
                                </div>
                              </td>

                              {/* Ward & Handover Notes */}
                              <td className="py-3 px-4 align-top max-w-xs">
                                <div className="font-medium text-slate-800">{log.ward}</div>
                                {log.notes && (
                                  <div className="text-[11px] text-slate-500 truncate mt-0.5">
                                    {log.notes}
                                  </div>
                                )}
                              </td>

                              {/* Overlap Validation & Status */}
                              <td className="py-3 px-4 align-top">
                                {hasConflict ? (
                                  <div className="space-y-1.5">
                                    <div className="text-red-700 font-semibold flex items-center gap-1">
                                      <span>Overlap Conflict Flagged</span>
                                    </div>
                                    {rowConflicts.map((c) => (
                                      <div
                                        key={c.conflictingLog.id}
                                        className="text-[11px] text-red-800 bg-white/90 border border-red-200 rounded px-2 py-1 space-y-1"
                                      >
                                        <div className="font-mono">
                                          Overlaps <strong>{c.conflictingLog.id}</strong> (
                                          {c.conflictingLog.shift_start}–
                                          {c.conflictingLog.shift_end}) by{' '}
                                          <strong>{c.overlapMinutes}m</strong> (
                                          {c.overlapWindowStart}–{c.overlapWindowEnd})
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => handleQuickResolveConflict(log, c)}
                                          className="text-[11px] font-semibold text-teal-700 hover:text-teal-900 underline inline-flex items-center gap-1"
                                        >
                                          <Wrench className="w-3 h-3" />
                                          <span>
                                            Auto-Resolve: Shift to {c.suggestedStart}–
                                            {c.suggestedEnd}
                                          </span>
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="space-y-0.5">
                                    <div
                                      className={`font-medium ${
                                        log.status === 'Clocked In'
                                          ? 'text-emerald-700'
                                          : 'text-slate-700'
                                      }`}
                                    >
                                      {log.status}
                                    </div>
                                    <div className="text-[11px] text-slate-500">
                                      Verified · Zero Overlap
                                    </div>
                                  </div>
                                )}
                              </td>

                              {/* Dynamic Columns added via ALTER TABLE */}
                              {extraAttendanceColumns.map((col) => (
                                <td
                                  key={col.name}
                                  className="py-3 px-4 font-mono text-slate-700 align-top whitespace-nowrap"
                                >
                                  {String(log[col.name] ?? 'NULL')}
                                </td>
                              ))}

                              {/* Actions */}
                              <td className="py-3 px-4 text-right whitespace-nowrap align-top">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingAttendance(log);
                                      setIsAttendanceModalOpen(true);
                                    }}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1"
                                  >
                                    <Edit3 className="w-3 h-3" />
                                    <span>Edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteAttendanceLog(log.id)}
                                    title="Delete attendance record via SQL DELETE"
                                    className="p-1 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {/* VIEW 2: 24-HOUR VISUAL SHIFT OVERLAP TIMELINE */}
          {activeNav === 'timeline' && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    01. 24-Hour Clinical Shift Overlap Matrix (2026-10-08)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Visualizing staff shift allocations across the 24-hour operational cycle.
                    Overlapping segments are highlighted in crimson; click any shift bar to edit or
                    resolve conflicts.
                  </p>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
                {staffList.map((staff) => {
                  const staffLogs = attendanceLogs.filter((l) => l.staff_id === staff.id);
                  const hasStaffConflict = staffLogs.some((l) => Boolean(conflictMap[l.id]?.length));

                  return (
                    <div
                      key={staff.id}
                      className={`p-4 space-y-2.5 ${
                        hasStaffConflict ? 'bg-red-50/40' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div>
                          <span className="font-semibold text-slate-900">{staff.full_name}</span>
                          <span className="text-slate-500">
                            {' '}
                            · <span className="font-mono">{staff.id}</span> · {staff.role} ·{' '}
                            {staff.department}
                          </span>
                        </div>
                        <div className="font-mono text-xs">
                          {hasStaffConflict ? (
                            <span className="text-red-700 font-semibold inline-flex items-center gap-1">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              Overlap Detected
                            </span>
                          ) : (
                            <span className="text-emerald-700">Schedule Nominal</span>
                          )}
                        </div>
                      </div>

                      {/* 24-hour visual ruler */}
                      <div className="relative h-12 bg-slate-100 rounded-lg border border-slate-200 overflow-hidden">
                        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                          <div
                            key={h}
                            style={{ left: `${(h / 24) * 100}%` }}
                            className="absolute top-0 bottom-0 border-l border-slate-200/90 text-[10px] font-mono text-slate-400 pl-1 pt-0.5 select-none"
                          >
                            {String(h).padStart(2, '0')}:00
                          </div>
                        ))}

                        {staffLogs.map((log, idx) => {
                          const [sMin, eMin] = getShiftIntervalMinutes(
                            log.shift_start,
                            log.shift_end
                          );
                          const left = Math.max(0, Math.min(100, (sMin / 1440) * 100));
                          const width = Math.max(
                            3,
                            Math.min(100 - left, ((eMin - sMin) / 1440) * 100)
                          );
                          const isConflicting = Boolean(conflictMap[log.id]?.length);

                          return (
                            <button
                              key={log.id}
                              type="button"
                              onClick={() => {
                                setEditingAttendance(log);
                                setIsAttendanceModalOpen(true);
                              }}
                              style={{
                                left: `${left}%`,
                                width: `${width}%`,
                                top: idx % 2 === 0 ? '16px' : '28px',
                              }}
                              title={`Click to edit ${log.id} (${log.shift_start}–${log.shift_end})`}
                              className={`absolute h-5 px-2 rounded text-[10px] font-mono text-white flex items-center justify-between truncate shadow-xs transition-transform hover:scale-[1.01] ${
                                isConflicting
                                  ? 'bg-red-600 ring-1 ring-red-300 z-10'
                                  : 'bg-teal-700 hover:bg-teal-800'
                              }`}
                            >
                              <span className="truncate">
                                {log.id}: {log.shift_start}–{log.shift_end} ({log.ward})
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* VIEW 3: LIVE RELATIONAL DATABASE EXPLORER (REFLECTS REAL-TIME DDL/DML CHANGES) */}
          {activeNav === 'explorer' && (
            <section className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    02. Live Relational Database Explorer
                  </h2>
                  <p className="text-xs text-slate-500">
                    Inspect all tables, columns, and records in real time. Any DDL (
                    <code className="font-mono">CREATE TABLE</code>,{' '}
                    <code className="font-mono">ALTER TABLE</code>) or DML command executed in the
                    workbench updates this view immediately.
                  </p>
                </div>

                {/* Table Selector Tabs */}
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/80 rounded-lg">
                  {Object.keys(tables).map((tName) => (
                    <button
                      key={tName}
                      type="button"
                      onClick={() => setExplorerTable(tName)}
                      className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap ${
                        explorerTable === tName
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tName} ({tables[tName]?.rows.length ?? 0})
                    </button>
                  ))}
                </div>
              </div>

              {tables[explorerTable] && (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono font-semibold text-slate-900">
                        TABLE public.{tables[explorerTable].tableName}
                      </span>
                      <span className="text-xs text-slate-500 ml-2">
                        · {tables[explorerTable].description}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-slate-600">
                      {tables[explorerTable].columns.length} columns ·{' '}
                      {tables[explorerTable].rows.length} rows
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500">
                          {tables[explorerTable].columns.map((col) => (
                            <th key={col.name} className="py-2.5 px-4 whitespace-nowrap">
                              <span className="text-slate-900 font-semibold">{col.name}</span>{' '}
                              <span className="text-[10px] text-teal-700 font-normal">
                                {col.type}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {tables[explorerTable].rows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={tables[explorerTable].columns.length}
                              className="py-8 px-4 text-center text-slate-500 font-sans"
                            >
                              Table <code className="font-mono">{explorerTable}</code> is currently
                              empty. Run an <code className="font-mono">INSERT INTO {explorerTable}</code>{' '}
                              statement in the DDL/DML Workbench to populate records.
                            </td>
                          </tr>
                        ) : (
                          tables[explorerTable].rows.map((row, rIdx) => (
                            <tr key={row.id || rIdx} className="hover:bg-slate-50">
                              {tables[explorerTable].columns.map((col) => (
                                <td
                                  key={col.name}
                                  className="py-2.5 px-4 text-slate-800 whitespace-nowrap"
                                >
                                  {String(row[col.name] ?? 'NULL')}
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* VIEW 4: RBAC ACCESS CONTROL POLICY MATRIX */}
          {activeNav === 'rbac' && (
            <section className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  03. Role-Based Access Control (RBAC) & DDL/DML Privilege Matrix
                </h2>
                <p className="text-xs text-slate-500">
                  Live permissions stored in <code className="font-mono">rbac_policies</code>.
                  Toggle privileges below (requires <code className="font-mono">SYS_ADMIN</code>)
                  and test role enforcement directly in the SQL Workbench.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold">
                        <th className="py-3 px-4">Policy ID</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Target Relation</th>
                        <th className="py-3 px-4 text-center">SELECT</th>
                        <th className="py-3 px-4 text-center">INSERT</th>
                        <th className="py-3 px-4 text-center">UPDATE</th>
                        <th className="py-3 px-4 text-center">DELETE</th>
                        <th className="py-3 px-4 text-center">DDL (Schema)</th>
                        <th className="py-3 px-4">Row-Level Security Scope</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-mono">
                      {((tables.rbac_policies?.rows || []) as RbacPolicyRecord[]).map((pol) => (
                        <tr key={pol.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 text-slate-700">{pol.id}</td>
                          <td className="py-3 px-4 font-semibold text-slate-900">
                            {pol.role_name}
                          </td>
                          <td className="py-3 px-4 text-teal-700">{pol.table_name}</td>
                          {(
                            [
                              'can_select',
                              'can_insert',
                              'can_update',
                              'can_delete',
                              'can_ddl',
                            ] as const
                          ).map((permKey) => (
                            <td key={permKey} className="py-3 px-4 text-center">
                              <input
                                type="checkbox"
                                checked={Boolean(pol[permKey])}
                                disabled={pol.role_name === 'SYS_ADMIN'}
                                onChange={() =>
                                  handleToggleRbacPolicy(pol.id, permKey, Boolean(pol[permKey]))
                                }
                                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 cursor-pointer disabled:opacity-60"
                              />
                            </td>
                          ))}
                          <td className="py-3 px-4 text-slate-500">{pol.rls_scope}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </main>

        {/* Right / Docked Admin DDL & DML Live SQL Workbench Pane */}
        {isSqlPaneOpen && (
          <div
            className={`w-full border-t lg:border-t-0 lg:h-[calc(100vh-57px)] lg:sticky lg:top-[57px] transition-all ${
              isSqlPaneExpanded ? 'lg:w-7/12' : 'lg:w-5/12 xl:w-4/12'
            }`}
          >
            <SqlWorkbenchPane
              tables={tables}
              activeRole={activeRole}
              onSwitchRole={setActiveRole}
              onExecuteSql={handleExecuteSql}
              executionHistory={sqlHistory}
              onClearHistory={() => setSqlHistory([])}
              onResetDatabase={handleResetDatabase}
              isExpanded={isSqlPaneExpanded}
              onToggleExpand={() => setIsSqlPaneExpanded((v) => !v)}
              onClosePane={() => setIsSqlPaneOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Attendance Create / Update Modal with Real-Time Shift Overlap Validation */}
      <AttendanceFormModal
        isOpen={isAttendanceModalOpen}
        onClose={() => {
          setIsAttendanceModalOpen(false);
          setEditingAttendance(null);
        }}
        editingLog={editingAttendance}
        allLogs={attendanceLogs}
        staffList={staffList}
        tableColumns={attendanceColumns}
        onSave={handleSaveAttendanceLog}
      />
    </div>
  );
}
