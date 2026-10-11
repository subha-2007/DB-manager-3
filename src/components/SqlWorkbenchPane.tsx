import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Database,
  History,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  RoleType,
  SqlExecutionResult,
  TableSchema,
} from '../types/database';
import { CLINICAL_SQL_PRESETS, SqlPreset } from '../utils/sqlEngine';

interface SqlWorkbenchPaneProps {
  tables: Record<string, TableSchema>;
  activeRole: RoleType;
  onSwitchRole: (role: RoleType) => void;
  onExecuteSql: (sql: string) => SqlExecutionResult;
  executionHistory: SqlExecutionResult[];
  onClearHistory: () => void;
  onResetDatabase: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClosePane?: () => void;
}

export const SqlWorkbenchPane: React.FC<SqlWorkbenchPaneProps> = ({
  tables,
  activeRole,
  onSwitchRole,
  onExecuteSql,
  executionHistory,
  onClearHistory,
  onResetDatabase,
  isExpanded = false,
  onToggleExpand,
  onClosePane,
}) => {
  const [sqlInput, setSqlInput] = useState<string>(CLINICAL_SQL_PRESETS[0].sql);
  const [activePresetId, setActivePresetId] = useState<string>(CLINICAL_SQL_PRESETS[0].id);
  const [selectedSchemaTable, setSelectedSchemaTable] = useState<string>('attendance_logs');
  const [consoleTab, setConsoleTab] = useState<'output' | 'schema' | 'history'>('output');

  const latestResult = executionHistory[0] || null;
  const tableNames = Object.keys(tables);

  const handleRunSql = () => {
    if (!sqlInput.trim()) return;
    onExecuteSql(sqlInput);
    setConsoleTab('output');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRunSql();
    }
  };

  const handleSelectPreset = (preset: SqlPreset) => {
    setActivePresetId(preset.id);
    setSqlInput(preset.sql);
  };

  return (
    <aside className="flex flex-col h-full bg-slate-900 text-slate-100 border-l border-slate-800 select-text">
      {/* Pane Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950/60">
        <div className="flex items-center gap-2.5 min-w-0">
          <Terminal className="w-4 h-4 text-teal-400 shrink-0" />
          <div className="truncate">
            <h2 className="text-sm font-semibold text-white tracking-wide truncate">
              Admin DDL & DML Live Workbench
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onResetDatabase}
            title="Reset database to initial hospital state"
            className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset DB</span>
          </button>

          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              title={isExpanded ? 'Restore split pane' : 'Expand workbench width'}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
            >
              {isExpanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {onClosePane && (
            <button
              type="button"
              onClick={onClosePane}
              title="Hide SQL Workbench pane"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Active Role RBAC Clearance Strip */}
      <div
        className={`px-4 py-2 text-xs border-b flex items-center justify-between gap-2 ${
          activeRole === 'SYS_ADMIN'
            ? 'bg-teal-950/50 border-teal-800/60 text-teal-200'
            : 'bg-amber-950/50 border-amber-800/60 text-amber-200'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {activeRole === 'SYS_ADMIN' ? (
            <ShieldCheck className="w-3.5 h-3.5 text-teal-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          )}
          <span className="truncate">
            Active Session Role: <strong className="font-mono text-white">{activeRole}</strong> ·{' '}
            {activeRole === 'SYS_ADMIN'
              ? 'Full DDL (CREATE/ALTER/DROP) & DML (INSERT/UPDATE/DELETE) enabled'
              : 'Restricted by RBAC Policy (DDL blocked for non-admin roles)'}
          </span>
        </div>

        {activeRole !== 'SYS_ADMIN' && (
          <button
            type="button"
            onClick={() => onSwitchRole('SYS_ADMIN')}
            className="px-2 py-0.5 text-[11px] font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xs transition-colors whitespace-nowrap shrink-0"
          >
            Switch to SYS_ADMIN
          </button>
        )}
      </div>

      {/* 1-Click DDL / DML Command Templates */}
      <div className="p-3.5 border-b border-slate-800 bg-slate-900/90 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-slate-400">
            Quick DDL & DML Clinical Templates (Click to load)
          </span>
          <span className="text-[11px] font-mono text-slate-500">
            Live State Sync: Active
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {CLINICAL_SQL_PRESETS.map((preset) => {
            const isSelected = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className={`px-2.5 py-1 text-xs rounded-md border text-left transition-colors inline-flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-teal-950/90 border-teal-500/80 text-teal-100 font-medium'
                    : 'bg-slate-800/70 border-slate-700/80 text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <span
                  className={`font-mono text-[10px] font-semibold ${
                    preset.category === 'DDL'
                      ? 'text-amber-400'
                      : preset.category === 'DML'
                      ? 'text-teal-400'
                      : 'text-sky-400'
                  }`}
                >
                  {preset.category}
                </span>
                <span className="truncate max-w-[230px]">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* SQL Code Editor */}
      <div className="p-3.5 border-b border-slate-800 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-slate-300 font-medium">
            <Code2 className="w-3.5 h-3.5 text-teal-400" />
            <span>SQL Statement Buffer</span>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Shortcut: Ctrl+Enter / Cmd+Enter
          </span>
        </div>

        <textarea
          rows={5}
          value={sqlInput}
          onChange={(e) => {
            setSqlInput(e.target.value);
            setActivePresetId('');
          }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder="Enter DDL (CREATE TABLE, ALTER TABLE ADD/DROP COLUMN, TRUNCATE) or DML (INSERT INTO, UPDATE, DELETE FROM, SELECT)..."
          className="w-full p-3 text-xs font-mono leading-relaxed bg-slate-950 text-teal-100 border border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 resize-y"
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
            {tableNames.map((tName) => (
              <button
                key={tName}
                type="button"
                onClick={() => {
                  setSelectedSchemaTable(tName);
                  setSqlInput(`SELECT * FROM ${tName};`);
                }}
                className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-xs transition-colors whitespace-nowrap"
                title={`Query ${tName}`}
              >
                {tName} ({tables[tName]?.rows.length ?? 0})
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setSqlInput('')}
              className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={handleRunSql}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-500 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shadow-xs"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Execute SQL</span>
            </button>
          </div>
        </div>
      </div>

      {/* Console Sub-Navigation Tabs */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setConsoleTab('output')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              consoleTab === 'output'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Execution Output
          </button>
          <button
            type="button"
            onClick={() => setConsoleTab('schema')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              consoleTab === 'schema'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Database className="w-3 h-3" />
            <span>Live Schema ({tableNames.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setConsoleTab('history')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              consoleTab === 'history'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <History className="w-3 h-3" />
            <span>Audit Log ({executionHistory.length})</span>
          </button>
        </div>

        {consoleTab === 'history' && executionHistory.length > 0 && (
          <button
            type="button"
            onClick={onClearHistory}
            className="text-[11px] text-slate-400 hover:text-red-400 inline-flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Console Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {consoleTab === 'output' && (
          <>
            {!latestResult ? (
              <div className="p-6 text-center border border-dashed border-slate-800 rounded-lg text-slate-400 space-y-2">
                <Terminal className="w-6 h-6 text-slate-500 mx-auto" />
                <p className="text-xs font-medium text-slate-300">
                  No SQL statements executed in this session yet
                </p>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Select any DDL or DML template above and click <strong>Execute SQL</strong> to
                  mutate the live clinical database and watch the table update immediately.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Status Banner */}
                <div
                  className={`p-3.5 rounded-lg border space-y-2 ${
                    latestResult.status === 'SUCCESS'
                      ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-100'
                      : latestResult.status === 'RBAC_DENIED'
                      ? 'bg-amber-950/50 border-amber-700/70 text-amber-100'
                      : 'bg-red-950/50 border-red-700/70 text-red-100'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {latestResult.status === 'SUCCESS' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                      )}
                      <span className="text-xs font-mono font-semibold">
                        {latestResult.commandType} · {latestResult.operation} ·{' '}
                        {latestResult.status}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-slate-300 shrink-0">
                      {latestResult.affectedRows} row(s) · {latestResult.executionMs}ms
                    </span>
                  </div>

                  <p className="text-xs leading-relaxed">{latestResult.message}</p>

                  {/* Real-time Shift Overlap Trigger Diagnostics */}
                  {latestResult.overlapWarnings && latestResult.overlapWarnings.length > 0 && (
                    <div className="mt-2 p-2.5 rounded-md bg-red-950/90 border border-red-500/80 text-red-100 space-y-1">
                      <div className="text-[11px] font-semibold text-red-300 flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span>Database Trigger: Overlapping Shift Conflict Detected</span>
                      </div>
                      {latestResult.overlapWarnings.map((warn, i) => (
                        <p key={i} className="text-[11px] font-mono text-red-200 leading-normal">
                          {warn}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                {/* Executed SQL snippet */}
                <div className="p-2.5 rounded-md bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto">
                  {latestResult.rawSql}
                </div>

                {/* If SELECT query returned rows, show live tabular result set */}
                {latestResult.rowsResult && latestResult.columnsResult && (
                  <div className="border border-slate-800 rounded-lg overflow-hidden">
                    <div className="px-3 py-1.5 bg-slate-950 border-b border-slate-800 text-[11px] font-mono text-slate-400 flex items-center justify-between">
                      <span>Query Result Set ({latestResult.rowsResult.length} rows)</span>
                      <span>Target: {latestResult.targetTable}</span>
                    </div>
                    <div className="overflow-x-auto max-h-64">
                      <table className="w-full text-left border-collapse text-xs font-mono">
                        <thead>
                          <tr className="border-b border-slate-800 bg-slate-900/90 text-slate-400">
                            {latestResult.columnsResult.map((col) => (
                              <th key={col} className="py-2 px-3 font-medium whitespace-nowrap">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {latestResult.rowsResult.length === 0 ? (
                            <tr>
                              <td
                                colSpan={latestResult.columnsResult.length}
                                className="py-4 px-3 text-center text-slate-500"
                              >
                                (0 rows returned)
                              </td>
                            </tr>
                          ) : (
                            latestResult.rowsResult.map((r, rIdx) => (
                              <tr key={rIdx} className="hover:bg-slate-800/50">
                                {latestResult.columnsResult!.map((col) => (
                                  <td
                                    key={col}
                                    className="py-1.5 px-3 text-slate-200 whitespace-nowrap"
                                  >
                                    {String(r[col] ?? 'NULL')}
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
              </div>
            )}
          </>
        )}

        {consoleTab === 'schema' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {tableNames.map((tName) => (
                <button
                  key={tName}
                  type="button"
                  onClick={() => setSelectedSchemaTable(tName)}
                  className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-colors ${
                    selectedSchemaTable === tName
                      ? 'bg-teal-950 border-teal-500 text-teal-200 font-semibold'
                      : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:text-white'
                  }`}
                >
                  {tName}
                </button>
              ))}
            </div>

            {tables[selectedSchemaTable] && (
              <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60">
                <div className="px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-mono font-semibold text-white">
                      TABLE {tables[selectedSchemaTable].tableName}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {tables[selectedSchemaTable].description}
                    </div>
                  </div>
                  <span className="text-xs font-mono text-teal-400">
                    {tables[selectedSchemaTable].rows.length} rows
                  </span>
                </div>

                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/60">
                      <th className="py-2 px-3">Column</th>
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Constraints</th>
                      <th className="py-2 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {tables[selectedSchemaTable].columns.map((col) => (
                      <tr key={col.name} className="hover:bg-slate-900/50">
                        <td className="py-2 px-3 text-slate-100 font-medium">{col.name}</td>
                        <td className="py-2 px-3 text-teal-400">{col.type}</td>
                        <td className="py-2 px-3 text-slate-400">
                          {col.isPrimaryKey
                            ? 'PRIMARY KEY'
                            : col.nullable
                            ? 'NULLABLE'
                            : 'NOT NULL'}
                          {col.defaultValue !== undefined && col.defaultValue !== null
                            ? ` · DEFAULT ${String(col.defaultValue)}`
                            : ''}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {!col.isPrimaryKey && (
                            <button
                              type="button"
                              onClick={() => {
                                setSqlInput(
                                  `ALTER TABLE ${selectedSchemaTable} DROP COLUMN ${col.name};`
                                );
                                setConsoleTab('output');
                              }}
                              className="text-[11px] text-red-400 hover:text-red-300 underline"
                            >
                              Drop SQL
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {consoleTab === 'history' && (
          <div className="space-y-2.5">
            {executionHistory.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-6">
                No DDL/DML audit history recorded yet.
              </p>
            ) : (
              executionHistory.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span
                      className={
                        item.status === 'SUCCESS'
                          ? 'text-emerald-400'
                          : item.status === 'RBAC_DENIED'
                          ? 'text-amber-400'
                          : 'text-red-400'
                      }
                    >
                      [{item.status}] {item.commandType} · {item.operation}
                    </span>
                    <span className="text-slate-500">
                      {item.timestamp} · Role: {item.actorRole}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-slate-200 bg-slate-900 p-2 rounded border border-slate-800/80 overflow-x-auto">
                    {item.rawSql}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>{item.message}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSqlInput(item.rawSql);
                        setConsoleTab('output');
                      }}
                      className="text-teal-400 hover:text-teal-300 font-medium whitespace-nowrap ml-2"
                    >
                      Load in Editor
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
