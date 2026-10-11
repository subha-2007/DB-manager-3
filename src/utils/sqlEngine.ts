import {
  AttendanceRecord,
  ColumnDefinition,
  RoleType,
  SqlDataType,
  SqlExecutionResult,
  StaffRecord,
  TableSchema,
} from '../types/database';
import { validateAttendanceOverlaps } from './shiftValidation';

/**
 * Checks if a role has permission to run a specific operation on a target table
 * based on the live `rbac_policies` table in the database.
 */
export function checkRbacPermission(
  tables: Record<string, TableSchema>,
  role: RoleType,
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL',
  targetTable: string
): { allowed: boolean; reason: string } {
  if (role === 'SYS_ADMIN') {
    return { allowed: true, reason: 'SYS_ADMIN holds UNRESTRICTED_SUPERUSER clearance.' };
  }

  const policies = tables.rbac_policies?.rows || [];
  const matchingPolicies = policies.filter(
    (p) =>
      String(p.role_name).toUpperCase() === role.toUpperCase() &&
      (String(p.table_name).toLowerCase() === targetTable.toLowerCase() || p.table_name === '*')
  );

  if (matchingPolicies.length === 0) {
    return {
      allowed: false,
      reason: `RBAC Policy Violation: Role '${role}' has no policy entry granting access to table '${targetTable}'. Switch role to SYS_ADMIN or update rbac_policies.`,
    };
  }

  const propMap: Record<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL', string> = {
    SELECT: 'can_select',
    INSERT: 'can_insert',
    UPDATE: 'can_update',
    DELETE: 'can_delete',
    DDL: 'can_ddl',
  };

  const prop = propMap[operation];
  const granted = matchingPolicies.some((p) => Boolean(p[prop]));

  if (!granted) {
    return {
      allowed: false,
      reason: `RBAC Policy Violation: Role '${role}' is denied ${operation} privilege on '${targetTable}' (${prop} = false).`,
    };
  }

  return { allowed: true, reason: `Authorized via RBAC policy for ${role}.` };
}

function parseSqlLiteral(raw: string): any {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function splitCsvRespectingQuotes(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') {
        parenDepth++;
        current += ch;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
      } else if (ch === ',' && parenDepth === 0) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    result.push(current.trim());
  }
  return result;
}

function normalizeSqlType(rawType: string): SqlDataType {
  const upper = rawType.toUpperCase().trim();
  if (upper.includes('INT') || upper.includes('NUM') || upper.includes('SERIAL')) return 'INTEGER';
  if (upper.includes('BOOL')) return 'BOOLEAN';
  if (upper === 'DATE') return 'DATE';
  if (upper === 'TIME') return 'TIME';
  if (upper.includes('TIMESTAMP') || upper.includes('DATETIME')) return 'TIMESTAMP';
  return 'TEXT';
}

function evaluateSingleCondition(row: Record<string, any>, clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  // Handle IS NULL / IS NOT NULL
  const isNotNullMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+IS\s+NOT\s+NULL$/i);
  if (isNotNullMatch) {
    const val = row[isNotNullMatch[1]];
    return val !== null && val !== undefined && val !== '';
  }
  const isNullMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+IS\s+NULL$/i);
  if (isNullMatch) {
    const val = row[isNullMatch[1]];
    return val === null || val === undefined || val === '';
  }

  // Handle IN (...)
  const inMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+IN\s*\((.+)\)$/i);
  if (inMatch) {
    const col = inMatch[1];
    const items = splitCsvRespectingQuotes(inMatch[2]).map(parseSqlLiteral);
    return items.some((item) => String(row[col]) === String(item));
  }

  // Handle LIKE
  const likeMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+LIKE\s+(.+)$/i);
  if (likeMatch) {
    const col = likeMatch[1];
    const pattern = String(parseSqlLiteral(likeMatch[2]));
    const regexStr = '^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$';
    const re = new RegExp(regexStr, 'i');
    return re.test(String(row[col] ?? ''));
  }

  // Handle standard operators: !=, <>, >=, <=, =, >, <
  const opMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*(!=|<>|>=|<=|=|>|<)\s*(.+)$/);
  if (!opMatch) return true;

  const col = opMatch[1];
  const op = opMatch[2];
  const targetVal = parseSqlLiteral(opMatch[3]);
  const actualVal = row[col];

  switch (op) {
    case '=':
      if (typeof actualVal === 'boolean' || typeof targetVal === 'boolean') {
        return String(actualVal).toLowerCase() === String(targetVal).toLowerCase();
      }
      return String(actualVal ?? '') === String(targetVal ?? '');
    case '!=':
    case '<>':
      return String(actualVal ?? '') !== String(targetVal ?? '');
    case '>':
      return Number(actualVal) > Number(targetVal) || String(actualVal) > String(targetVal);
    case '<':
      return Number(actualVal) < Number(targetVal) || String(actualVal) < String(targetVal);
    case '>=':
      return Number(actualVal) >= Number(targetVal) || String(actualVal) >= String(targetVal);
    case '<=':
      return Number(actualVal) <= Number(targetVal) || String(actualVal) <= String(targetVal);
    default:
      return true;
  }
}

function evaluateWhereClause(row: Record<string, any>, whereClause?: string): boolean {
  if (!whereClause || !whereClause.trim()) return true;

  // Split by OR at top level, then by AND
  const orBranches = whereClause.split(/\s+OR\s+/i);
  return orBranches.some((branch) => {
    const andClauses = branch.split(/\s+AND\s+/i);
    return andClauses.every((c) => evaluateSingleCondition(row, c));
  });
}

/**
 * Strips SQL comments and executes a single SQL statement against a cloned copy of tables.
 */
export function executeSqlCommand(
  currentTables: Record<string, TableSchema>,
  rawSqlInput: string,
  actorRole: RoleType
): {
  nextTables: Record<string, TableSchema>;
  result: SqlExecutionResult;
} {
  const startTime = performance.now();
  // Deep clone tables for immutable React state updates
  const nextTables: Record<string, TableSchema> = JSON.parse(JSON.stringify(currentTables));

  // Strip comments
  const cleaned = rawSqlInput
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  // If multiple statements separated by ;, take all non-empty statements and run sequentially
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    return {
      nextTables: currentTables,
      result: {
        id: `SQL-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        actorRole,
        commandType: 'ERROR',
        operation: 'EMPTY',
        targetTable: '-',
        rawSql: rawSqlInput,
        status: 'ERROR',
        message: 'No executable SQL statement found. Enter a valid DDL, DML, or SELECT command.',
        affectedRows: 0,
        executionMs: 0.4,
      },
    };
  }

  let lastResult: SqlExecutionResult | null = null;
  let totalAffected = 0;
  const accumulatedWarnings: string[] = [];

  for (const stmt of statements) {
    const singleExecution = executeSingleStatement(nextTables, stmt, actorRole);
    if (singleExecution.status !== 'SUCCESS') {
      return {
        nextTables: currentTables, // Rollback on error in multi-statement batch
        result: {
          ...singleExecution,
          rawSql: rawSqlInput,
          executionMs: Number((performance.now() - startTime).toFixed(2)),
        },
      };
    }
    totalAffected += singleExecution.affectedRows;
    if (singleExecution.overlapWarnings?.length) {
      accumulatedWarnings.push(...singleExecution.overlapWarnings);
    }
    lastResult = singleExecution;
  }

  const elapsed = Number((performance.now() - startTime + 0.8).toFixed(2));
  return {
    nextTables,
    result: {
      ...(lastResult as SqlExecutionResult),
      rawSql: rawSqlInput,
      affectedRows: totalAffected,
      executionMs: elapsed,
      overlapWarnings: accumulatedWarnings.length > 0 ? accumulatedWarnings : undefined,
    },
  };
}

function executeSingleStatement(
  tables: Record<string, TableSchema>,
  stmt: string,
  actorRole: RoleType
): SqlExecutionResult {
  const id = `SQL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const timestamp = new Date().toLocaleTimeString();
  const normalized = stmt.replace(/\s+/g, ' ').trim();

  // 1. CREATE TABLE [IF NOT EXISTS] table_name (col_defs...)
  const createMatch = normalized.match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\((.+)\)$/i
  );
  if (createMatch) {
    const tableName = createMatch[1].toLowerCase();
    const colDefsRaw = createMatch[2];

    const perm = checkRbacPermission(tables, actorRole, 'DDL', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'CREATE TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.1,
      };
    }

    if (tables[tableName] && !/IF\s+NOT\s+EXISTS/i.test(normalized)) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'CREATE TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' already exists in schema.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const colParts = splitCsvRespectingQuotes(colDefsRaw);
    const columns: ColumnDefinition[] = colParts.map((part, idx) => {
      const tokens = part.trim().split(/\s+/);
      const colName = tokens[0].replace(/["'`]/g, '');
      const colType = normalizeSqlType(tokens[1] || 'TEXT');
      const isPrimaryKey = /PRIMARY\s+KEY/i.test(part) || (idx === 0 && colName === 'id');
      const nullable = !/NOT\s+NULL/i.test(part) && !isPrimaryKey;
      const defaultMatch = part.match(/DEFAULT\s+([^\s,]+)/i);
      const defaultValue = defaultMatch ? parseSqlLiteral(defaultMatch[1]) : undefined;

      return {
        name: colName,
        type: colType,
        nullable,
        isPrimaryKey,
        defaultValue,
      };
    });

    tables[tableName] = {
      tableName,
      description: `Custom clinical relation created via Admin DDL Workbench (${columns.length} columns)`,
      columns,
      rows: [],
    };

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DDL',
      operation: 'CREATE TABLE',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DDL executed: Created table '${tableName}' with ${columns.length} columns (${columns
        .map((c) => c.name)
        .join(', ')}). Schema browser updated in real time.`,
      affectedRows: 0,
      executionMs: 2.1,
    };
  }

  // 2. ALTER TABLE table_name ADD [COLUMN] col_name col_type [DEFAULT val]
  const alterAddMatch = normalized.match(
    /^ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ADD\s+(?:COLUMN\s+)?([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_()]+)(?:\s+DEFAULT\s+(.+))?$/i
  );
  if (alterAddMatch) {
    const tableName = alterAddMatch[1].toLowerCase();
    const colName = alterAddMatch[2];
    const colType = normalizeSqlType(alterAddMatch[3]);
    const defaultRaw = alterAddMatch[4];

    const perm = checkRbacPermission(tables, actorRole, 'DDL', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE ADD COLUMN',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    if (table.columns.some((c) => c.name.toLowerCase() === colName.toLowerCase())) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Column '${colName}' already exists on table '${tableName}'.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const defaultVal =
      defaultRaw !== undefined
        ? parseSqlLiteral(defaultRaw.replace(/\s+NOT\s+NULL$/i, ''))
        : colType === 'BOOLEAN'
        ? false
        : colType === 'INTEGER'
        ? 0
        : null;

    table.columns.push({
      name: colName,
      type: colType,
      nullable: true,
      defaultValue: defaultVal,
    });

    table.rows.forEach((row) => {
      row[colName] = defaultVal;
    });

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DDL',
      operation: 'ALTER TABLE ADD',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DDL executed: Added column '${colName}' (${colType}) to '${tableName}' and initialized ${table.rows.length} existing row(s).`,
      affectedRows: table.rows.length,
      executionMs: 1.8,
    };
  }

  // 3. ALTER TABLE table_name DROP [COLUMN] col_name
  const alterDropMatch = normalized.match(
    /^ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+DROP\s+(?:COLUMN\s+)?([a-zA-Z0-9_]+)$/i
  );
  if (alterDropMatch) {
    const tableName = alterDropMatch[1].toLowerCase();
    const colName = alterDropMatch[2];

    const perm = checkRbacPermission(tables, actorRole, 'DDL', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE DROP COLUMN',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const colIdx = table.columns.findIndex((c) => c.name.toLowerCase() === colName.toLowerCase());
    if (colIdx === -1) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'ALTER TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Column '${colName}' does not exist on '${tableName}'.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const exactName = table.columns[colIdx].name;
    table.columns.splice(colIdx, 1);
    table.rows.forEach((row) => {
      delete row[exactName];
    });

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DDL',
      operation: 'ALTER TABLE DROP',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DDL executed: Dropped column '${exactName}' from '${tableName}'.`,
      affectedRows: table.rows.length,
      executionMs: 1.5,
    };
  }

  // 4. DROP TABLE [IF EXISTS] table_name
  const dropTableMatch = normalized.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)$/i);
  if (dropTableMatch) {
    const tableName = dropTableMatch[1].toLowerCase();
    const perm = checkRbacPermission(tables, actorRole, 'DDL', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'DROP TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    if (['staff', 'attendance_logs', 'rbac_policies'].includes(tableName)) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'DROP TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Protected Core Schema Guard: Cannot drop core clinical table '${tableName}'. You may DROP custom tables or use DELETE/ALTER on core tables.`,
        affectedRows: 0,
        executionMs: 1.1,
      };
    }

    if (!tables[tableName]) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'DROP TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Table '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const rowCount = tables[tableName].rows.length;
    delete tables[tableName];

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DDL',
      operation: 'DROP TABLE',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DDL executed: Dropped table '${tableName}' (${rowCount} rows purged).`,
      affectedRows: rowCount,
      executionMs: 1.6,
    };
  }

  // 5. TRUNCATE [TABLE] table_name
  const truncateMatch = normalized.match(/^TRUNCATE\s+(?:TABLE\s+)?([a-zA-Z0-9_]+)$/i);
  if (truncateMatch) {
    const tableName = truncateMatch[1].toLowerCase();
    const perm = checkRbacPermission(tables, actorRole, 'DDL', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'TRUNCATE TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }
    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DDL',
        operation: 'TRUNCATE TABLE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Table '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }
    const removed = table.rows.length;
    table.rows = [];
    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DDL',
      operation: 'TRUNCATE TABLE',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DDL executed: Truncated table '${tableName}' (${removed} rows removed).`,
      affectedRows: removed,
      executionMs: 1.3,
    };
  }

  // 6. INSERT INTO table_name [(col1, col2, ...)] VALUES (v1, v2, ...)
  const insertMatch = normalized.match(
    /^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]+)\))?\s*VALUES\s*(.+)$/i
  );
  if (insertMatch) {
    const tableName = insertMatch[1].toLowerCase();
    const colsRaw = insertMatch[2];
    const valuesSegment = insertMatch[3].trim();

    const perm = checkRbacPermission(tables, actorRole, 'INSERT', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'INSERT',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'INSERT',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const targetCols = colsRaw
      ? splitCsvRespectingQuotes(colsRaw).map((c) => c.replace(/["'`]/g, '').trim())
      : table.columns.map((c) => c.name);

    // Extract tuple groups: (val1, val2), (val3, val4)
    const tupleMatches = [...valuesSegment.matchAll(/\(([^)]+)\)/g)];
    if (tupleMatches.length === 0) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'INSERT',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: 'Invalid VALUES syntax in INSERT statement.',
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const overlapWarnings: string[] = [];
    let insertedCount = 0;

    for (const tupleMatch of tupleMatches) {
      const vals = splitCsvRespectingQuotes(tupleMatch[1]).map(parseSqlLiteral);
      if (vals.length !== targetCols.length) {
        return {
          id,
          timestamp,
          actorRole,
          commandType: 'DML',
          operation: 'INSERT',
          targetTable: tableName,
          rawSql: stmt,
          status: 'ERROR',
          message: `Column count (${targetCols.length}) does not match value count (${vals.length}).`,
          affectedRows: 0,
          executionMs: 1.0,
        };
      }

      const newRow: Record<string, any> = {};
      table.columns.forEach((col) => {
        newRow[col.name] = col.defaultValue ?? null;
      });

      targetCols.forEach((colName, idx) => {
        newRow[colName] = vals[idx];
      });

      if (!newRow.id) {
        const prefix = tableName.slice(0, 3).toUpperCase();
        newRow.id = `${prefix}-${Math.floor(500 + Math.random() * 499)}`;
      }

      // Check primary key uniqueness
      if (table.rows.some((r) => String(r.id) === String(newRow.id))) {
        return {
          id,
          timestamp,
          actorRole,
          commandType: 'DML',
          operation: 'INSERT',
          targetTable: tableName,
          rawSql: stmt,
          status: 'ERROR',
          message: `Duplicate key value violates unique constraint "${tableName}_pkey" (id = '${newRow.id}').`,
          affectedRows: 0,
          executionMs: 1.1,
        };
      }

      // If inserting into attendance_logs, run real-time shift overlap detector trigger!
      if (tableName === 'attendance_logs') {
        const staffRows = (tables.staff?.rows || []) as StaffRecord[];
        const existingLogs = table.rows as AttendanceRecord[];
        const conflicts = validateAttendanceOverlaps(
          {
            id: newRow.id,
            staff_id: newRow.staff_id,
            shift_date: newRow.shift_date,
            shift_start: newRow.shift_start,
            shift_end: newRow.shift_end,
          },
          existingLogs,
          staffRows
        );

        if (conflicts.length > 0) {
          newRow.status = 'Conflict Flagged';
          for (const c of conflicts) {
            overlapWarnings.push(
              `SHIFT OVERLAP TRIGGER: Inserted log '${newRow.id}' (${newRow.shift_start}–${newRow.shift_end}) for staff '${newRow.staff_id}' overlaps existing shift '${c.conflictingLog.id}' (${c.conflictingLog.shift_start}–${c.conflictingLog.shift_end}) by ${c.overlapMinutes} mins (${c.overlapWindowStart}–${c.overlapWindowEnd}). Row automatically flagged in database.`
            );
          }
        }
      }

      table.rows.unshift(newRow);
      insertedCount++;
    }

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DML',
      operation: 'INSERT',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DML executed: Inserted ${insertedCount} row(s) into '${tableName}'.${
        overlapWarnings.length > 0
          ? ` (${overlapWarnings.length} overlapping shift conflict detected & highlighted!)`
          : ''
      }`,
      affectedRows: insertedCount,
      executionMs: 1.9,
      overlapWarnings: overlapWarnings.length > 0 ? overlapWarnings : undefined,
    };
  }

  // 7. UPDATE table_name SET col = val, ... [WHERE condition]
  const updateMatch = normalized.match(
    /^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i
  );
  if (updateMatch) {
    const tableName = updateMatch[1].toLowerCase();
    const setSegment = updateMatch[2];
    const whereSegment = updateMatch[3];

    const perm = checkRbacPermission(tables, actorRole, 'UPDATE', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'UPDATE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'UPDATE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const assignments = splitCsvRespectingQuotes(setSegment).map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      const col = pair.slice(0, eqIdx).trim();
      const val = parseSqlLiteral(pair.slice(eqIdx + 1));
      return { col, val };
    });

    if (assignments.some((a) => a === null)) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'UPDATE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: 'Invalid SET assignment syntax in UPDATE command.',
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    let updatedCount = 0;
    const updatedIds: string[] = [];

    table.rows.forEach((row) => {
      if (evaluateWhereClause(row, whereSegment)) {
        assignments.forEach((a) => {
          if (a) row[a.col] = a.val;
        });
        updatedCount++;
        if (row.id) updatedIds.push(String(row.id));
      }
    });

    const overlapWarnings: string[] = [];
    if (tableName === 'attendance_logs' && updatedCount > 0) {
      const staffRows = (tables.staff?.rows || []) as StaffRecord[];
      const allLogs = table.rows as AttendanceRecord[];
      for (const row of allLogs) {
        const conflicts = validateAttendanceOverlaps(
          {
            id: row.id,
            staff_id: row.staff_id,
            shift_date: row.shift_date,
            shift_start: row.shift_start,
            shift_end: row.shift_end,
          },
          allLogs,
          staffRows
        );
        if (conflicts.length > 0 && updatedIds.includes(String(row.id))) {
          row.status = 'Conflict Flagged';
          for (const c of conflicts) {
            overlapWarnings.push(
              `SHIFT OVERLAP TRIGGER: Updated log '${row.id}' (${row.shift_start}–${row.shift_end}) overlaps with '${c.conflictingLog.id}' (${c.conflictingLog.shift_start}–${c.conflictingLog.shift_end}) by ${c.overlapMinutes} mins.`
            );
          }
        } else if (conflicts.length === 0 && row.status === 'Conflict Flagged') {
          // Automatically clear conflict status if SQL UPDATE resolved the overlap!
          row.status = 'Scheduled';
        }
      }
    }

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DML',
      operation: 'UPDATE',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DML executed: Updated ${updatedCount} row(s) in '${tableName}'. Live UI state synchronized.`,
      affectedRows: updatedCount,
      executionMs: 1.7,
      overlapWarnings: overlapWarnings.length > 0 ? overlapWarnings : undefined,
    };
  }

  // 8. DELETE FROM table_name [WHERE condition]
  const deleteMatch = normalized.match(
    /^DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/i
  );
  if (deleteMatch) {
    const tableName = deleteMatch[1].toLowerCase();
    const whereSegment = deleteMatch[2];

    const perm = checkRbacPermission(tables, actorRole, 'DELETE', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'DELETE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DML',
        operation: 'DELETE',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const beforeCount = table.rows.length;
    table.rows = table.rows.filter((row) => !evaluateWhereClause(row, whereSegment));
    const deletedCount = beforeCount - table.rows.length;

    // Re-evaluate attendance_logs conflicts so previously conflicting rows clear if their counterpart was deleted
    if (tableName === 'attendance_logs' && deletedCount > 0) {
      const staffRows = (tables.staff?.rows || []) as StaffRecord[];
      const allLogs = table.rows as AttendanceRecord[];
      for (const row of allLogs) {
        const conflicts = validateAttendanceOverlaps(
          {
            id: row.id,
            staff_id: row.staff_id,
            shift_date: row.shift_date,
            shift_start: row.shift_start,
            shift_end: row.shift_end,
          },
          allLogs,
          staffRows
        );
        if (conflicts.length === 0 && row.status === 'Conflict Flagged') {
          row.status = 'Clocked In';
        }
      }
    }

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DML',
      operation: 'DELETE',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `DML executed: Deleted ${deletedCount} row(s) from '${tableName}'.`,
      affectedRows: deletedCount,
      executionMs: 1.5,
    };
  }

  // 9. SELECT cols FROM table_name [WHERE ...] [ORDER BY ...] [LIMIT ...]
  const selectMatch = normalized.match(
    /^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?$/i
  );
  if (selectMatch) {
    const selectColsRaw = selectMatch[1].trim();
    const tableName = selectMatch[2].toLowerCase();
    const whereSegment = selectMatch[3];
    const orderByCol = selectMatch[4];
    const orderDir = (selectMatch[5] || 'ASC').toUpperCase();
    const limitVal = selectMatch[6] ? parseInt(selectMatch[6], 10) : undefined;

    const perm = checkRbacPermission(tables, actorRole, 'SELECT', tableName);
    if (!perm.allowed) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DQL',
        operation: 'SELECT',
        targetTable: tableName,
        rawSql: stmt,
        status: 'RBAC_DENIED',
        message: perm.reason,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    const table = tables[tableName];
    if (!table) {
      return {
        id,
        timestamp,
        actorRole,
        commandType: 'DQL',
        operation: 'SELECT',
        targetTable: tableName,
        rawSql: stmt,
        status: 'ERROR',
        message: `Relation '${tableName}' does not exist.`,
        affectedRows: 0,
        executionMs: 1.0,
      };
    }

    let matchedRows = table.rows.filter((r) => evaluateWhereClause(r, whereSegment));

    if (orderByCol) {
      matchedRows = [...matchedRows].sort((a, b) => {
        const va = a[orderByCol] ?? '';
        const vb = b[orderByCol] ?? '';
        if (va < vb) return orderDir === 'ASC' ? -1 : 1;
        if (va > vb) return orderDir === 'ASC' ? 1 : -1;
        return 0;
      });
    }

    if (limitVal !== undefined && !isNaN(limitVal)) {
      matchedRows = matchedRows.slice(0, limitVal);
    }

    const columnsResult =
      selectColsRaw === '*'
        ? table.columns.map((c) => c.name)
        : splitCsvRespectingQuotes(selectColsRaw).map((c) => c.trim());

    const projectedRows = matchedRows.map((row) => {
      const obj: Record<string, any> = {};
      columnsResult.forEach((col) => {
        obj[col] = row[col];
      });
      return obj;
    });

    return {
      id,
      timestamp,
      actorRole,
      commandType: 'DQL',
      operation: 'SELECT',
      targetTable: tableName,
      rawSql: stmt,
      status: 'SUCCESS',
      message: `Query returned ${projectedRows.length} row(s) from '${tableName}'.`,
      affectedRows: projectedRows.length,
      executionMs: 1.2,
      rowsResult: projectedRows,
      columnsResult,
    };
  }

  return {
    id,
    timestamp,
    actorRole,
    commandType: 'ERROR',
    operation: 'SYNTAX_ERROR',
    targetTable: '-',
    rawSql: stmt,
    status: 'ERROR',
    message:
      'Unsupported or malformed SQL syntax. Supported commands: CREATE TABLE, ALTER TABLE (ADD/DROP COLUMN), DROP TABLE, TRUNCATE TABLE, INSERT INTO, UPDATE ... SET, DELETE FROM, and SELECT ... FROM.',
    affectedRows: 0,
    executionMs: 0.9,
  };
}

export interface SqlPreset {
  id: string;
  label: string;
  category: 'DML' | 'DDL' | 'DQL';
  description: string;
  sql: string;
}

export const CLINICAL_SQL_PRESETS: SqlPreset[] = [
  {
    id: 'dml-insert-overlap',
    label: 'INSERT Overlapping Shift (Test Conflict Trigger)',
    category: 'DML',
    description: 'Inserts a shift for Marcus Vance (STF-102) from 12:30 to 16:30 that overlaps both his 06:00–14:00 and 14:00–22:00 shifts.',
    sql: `INSERT INTO attendance_logs (id, staff_id, shift_date, shift_start, shift_end, ward, status, notes)\nVALUES ('ATT-409', 'STF-102', '2026-10-08', '12:30', '16:30', 'ER-Resuscitation Pod', 'Scheduled', 'Emergency float coverage');`,
  },
  {
    id: 'dml-resolve-overlap',
    label: 'UPDATE Shift Hours (Resolve ATT-402 Overlap)',
    category: 'DML',
    description: 'Updates Dr. Elena Rostova’s second shift (ATT-402) from 13:30–19:30 to 15:00–21:00 so it no longer overlaps ATT-401 (07:00–15:00).',
    sql: `UPDATE attendance_logs\nSET shift_start = '15:00', shift_end = '21:00', notes = 'Adjusted to contiguous post-ICU shift (Overlap resolved)'\nWHERE id = 'ATT-402';`,
  },
  {
    id: 'ddl-alter-add-col',
    label: 'ALTER TABLE: Add overtime_approved Column',
    category: 'DDL',
    description: 'Dynamically adds an overtime_approved BOOLEAN column to attendance_logs and populates all live records.',
    sql: `ALTER TABLE attendance_logs ADD COLUMN overtime_approved BOOLEAN DEFAULT false;`,
  },
  {
    id: 'dml-approve-overtime',
    label: 'UPDATE: Approve ICU Overtime Shifts',
    category: 'DML',
    description: 'Sets overtime_approved = true for all attendance logs in ICU-North (Pods A-D).',
    sql: `UPDATE attendance_logs\nSET overtime_approved = true\nWHERE ward = 'ICU-North (Pods A-D)';`,
  },
  {
    id: 'ddl-create-oncall',
    label: 'CREATE TABLE: on_call_rotations + Seed Row',
    category: 'DDL',
    description: 'Creates a brand-new table on_call_rotations in the database and inserts an initial surgical rotation record.',
    sql: `CREATE TABLE on_call_rotations (id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, specialty TEXT, pager_ext TEXT, shift_date DATE);\nINSERT INTO on_call_rotations (id, staff_id, specialty, pager_ext, shift_date) VALUES ('OCR-101', 'STF-103', 'Cardiothoracic Trauma', 'EXT-4490', '2026-10-08');`,
  },
  {
    id: 'dml-delete-flagged',
    label: 'DELETE Conflict-Flagged Shift (ATT-402)',
    category: 'DML',
    description: 'Deletes the conflicting attendance log ATT-402 and automatically clears the conflict state on ATT-401.',
    sql: `DELETE FROM attendance_logs WHERE id = 'ATT-402';`,
  },
  {
    id: 'dql-select-conflicts',
    label: 'SELECT Flagged Attendance Shifts',
    category: 'DQL',
    description: 'Queries all rows in attendance_logs where status is Conflict Flagged.',
    sql: `SELECT id, staff_id, shift_date, shift_start, shift_end, ward, status\nFROM attendance_logs\nWHERE status = 'Conflict Flagged'\nORDER BY shift_start ASC;`,
  },
];
