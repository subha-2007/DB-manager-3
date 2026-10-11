export type RoleType = 'SYS_ADMIN' | 'CHARGE_NURSE' | 'ATTENDING_MD' | 'AUDITOR';

export type SqlDataType = 'TEXT' | 'INTEGER' | 'BOOLEAN' | 'DATE' | 'TIME' | 'TIMESTAMP';

export interface ColumnDefinition {
  name: string;
  type: SqlDataType;
  nullable: boolean;
  isPrimaryKey?: boolean;
  defaultValue?: string | number | boolean | null;
}

export interface TableSchema {
  tableName: string;
  description: string;
  columns: ColumnDefinition[];
  rows: Record<string, any>[];
}

export interface StaffRecord {
  id: string;
  employee_code: string;
  full_name: string;
  role: string;
  department: string;
  license_no: string;
  clearance_level: number;
  status: 'Active' | 'On Leave' | 'Off Duty';
  [key: string]: any;
}

export interface AttendanceRecord {
  id: string;
  staff_id: string;
  shift_date: string;
  shift_start: string;
  shift_end: string;
  ward: string;
  status: 'Scheduled' | 'Clocked In' | 'Completed' | 'Conflict Flagged';
  notes: string;
  override_reason?: string;
  [key: string]: any;
}

export interface PatientRecord {
  id: string;
  mrn: string;
  full_name: string;
  ward: string;
  attending_id: string;
  triage_level: string;
  admission_date: string;
  diagnosis: string;
  [key: string]: any;
}

export interface RbacPolicyRecord {
  id: string;
  role_name: RoleType;
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_ddl: boolean;
  rls_scope: string;
  [key: string]: any;
}

export interface ShiftOverlapConflict {
  conflictingLog: AttendanceRecord;
  staffMember?: StaffRecord;
  overlapMinutes: number;
  overlapWindowStart: string;
  overlapWindowEnd: string;
  suggestedStart: string;
  suggestedEnd: string;
}

export interface SqlExecutionResult {
  id: string;
  timestamp: string;
  actorRole: RoleType;
  commandType: 'DDL' | 'DML' | 'DQL' | 'ERROR';
  operation: string;
  targetTable: string;
  rawSql: string;
  status: 'SUCCESS' | 'ERROR' | 'RBAC_DENIED';
  message: string;
  affectedRows: number;
  executionMs: number;
  rowsResult?: Record<string, any>[];
  columnsResult?: string[];
  overlapWarnings?: string[];
}
