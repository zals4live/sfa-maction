import * as XLSX from 'xlsx'
import {
  buildWorksheetTable,
  worksheetTableToAoa,
  getReportTitle,
  type WorksheetTable,
  type WorksheetCell,
} from '@maction/utils'

import type {
  DashboardKpiResponseType,
  BranchPerformanceResponseType,
  CallRateReportResponseType,
  OrderRegisterResponseType,
  FraudIncidentResponseType,
} from './schemas'

/** A column projection: header label plus a value accessor over a record. */
interface Column<T> {
  header: string
  value: (record: T) => WorksheetCell
}

type BranchRow = BranchPerformanceResponseType['data'][number]
type CallRateRow = CallRateReportResponseType['data'][number]
type OrderRow = OrderRegisterResponseType['data'][number]
type FraudRow = FraudIncidentResponseType['data'][number]

const branchColumns: ReadonlyArray<Column<BranchRow>> = [
  { header: 'Rank', value: (r) => r.rank },
  { header: 'Branch', value: (r) => r.soffice_name },
  { header: 'Total Visits', value: (r) => r.total_visits },
  { header: 'Total Revenue', value: (r) => r.total_revenue },
  { header: 'Strike Rate %', value: (r) => r.strike_rate_pct },
  { header: 'Salesman Visits', value: (r) => r.SALESMAN.total_visits },
  { header: 'Salesman Call Rate %', value: (r) => r.SALESMAN.call_rate_pct },
  { header: 'MR Visits', value: (r) => r.MR.total_visits },
  { header: 'MR Call Rate %', value: (r) => r.MR.call_rate_pct },
]

const callRateColumns: ReadonlyArray<Column<CallRateRow>> = [
  { header: 'User', value: (r) => r.user_name },
  { header: 'Role', value: (r) => r.role_label },
  { header: 'Planned', value: (r) => r.total_planned },
  { header: 'Visited', value: (r) => r.total_visited },
  { header: 'Call Rate %', value: (r) => r.call_rate_pct },
]

const orderColumns: ReadonlyArray<Column<OrderRow>> = [
  { header: 'Order Number', value: (r) => r.order_number },
  { header: 'Status', value: (r) => r.status },
  { header: 'Total Amount', value: (r) => r.total_amount },
  { header: 'Customer ID', value: (r) => r.customer_id },
  { header: 'Salesman ID', value: (r) => r.user_id },
  { header: 'Created At', value: (r) => r.created_at },
]

const fraudColumns: ReadonlyArray<Column<FraudRow>> = [
  { header: 'Incident ID', value: (r) => r.id },
  { header: 'User ID', value: (r) => r.user_id },
  { header: 'Fraud Type', value: (r) => r.fraud_type },
  { header: 'Severity', value: (r) => r.severity },
  { header: 'Claimed Lat', value: (r) => r.claimed_lat },
  { header: 'Claimed Lng', value: (r) => r.claimed_lng },
  { header: 'Speed (km/h)', value: (r) => r.calculated_speed_kmh },
  { header: 'Action Taken', value: (r) => r.action_taken },
  { header: 'Created At', value: (r) => r.created_at },
]

/** Flatten the dashboard KPI (a single object) into a label/value table. */
export function buildDashboardKpiTable(payload: DashboardKpiResponseType): WorksheetTable {
  const d = payload.data
  const rows: WorksheetCell[][] = [
    ['Period', d.period],
    ['Total Active Users', d.total_active_users],
    ['Total Orders', d.total_orders],
    ['Total Revenue', d.total_revenue],
    ['Salesman Visits', d.SALESMAN.total_visits],
    ['Salesman Effective Calls', d.SALESMAN.effective_calls],
    ['Salesman Call Rate %', d.SALESMAN.call_rate_pct],
    ['MR Visits', d.MR.total_visits],
    ['MR Effective Calls', d.MR.effective_calls],
    ['MR Call Rate %', d.MR.call_rate_pct],
  ]
  return { header: ['Metric', 'Value'], rows }
}

/** Build the worksheet table for tabular (array-backed) report payloads. */
export function buildBranchPerformanceTable(
  payload: BranchPerformanceResponseType
): WorksheetTable {
  return buildWorksheetTable(payload.data, branchColumns)
}

export function buildCallRateTable(payload: CallRateReportResponseType): WorksheetTable {
  return buildWorksheetTable(payload.data, callRateColumns)
}

export function buildOrderRegisterTable(payload: OrderRegisterResponseType): WorksheetTable {
  return buildWorksheetTable(payload.data, orderColumns)
}

export function buildFraudIncidentTable(payload: FraudIncidentResponseType): WorksheetTable {
  return buildWorksheetTable(payload.data, fraudColumns)
}

/**
 * Serialize a worksheet table to an `.xlsx` Buffer. SheetJS's `write` is
 * synchronous and CPU-bound, so we isolate it here and yield the event loop
 * (via `setImmediate`) before running it — keeping the Elysia handler async and
 * non-blocking for the surrounding request pipeline.
 */
export async function serializeWorkbook(
  table: WorksheetTable,
  reportType: string
): Promise<Buffer> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetTableToAoa(table))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName(reportType))
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** Excel sheet names are capped at 31 chars and disallow several characters. */
function sheetName(reportType: string): string {
  return getReportTitle(reportType).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)
}
