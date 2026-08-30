import { describe, it, expect } from 'bun:test'
import * as XLSX from 'xlsx'
import { buildExportFilename, XLSX_CONTENT_TYPE } from '@maction/utils'

import {
  buildDashboardKpiTable,
  buildBranchPerformanceTable,
  buildCallRateTable,
  serializeWorkbook,
} from '../excelExport'
import type {
  DashboardKpiResponseType,
  BranchPerformanceResponseType,
  CallRateReportResponseType,
} from '../schemas'

const dashboardPayload: DashboardKpiResponseType = {
  data: {
    period: 'month',
    total_active_users: 12,
    total_orders: 340,
    total_revenue: 125_000_000,
    SALESMAN: { total_visits: 200, effective_calls: 180, call_rate_pct: 90 },
    MR: { total_visits: 150, effective_calls: 120, call_rate_pct: 80 },
  },
  meta: { soffice_id: null, generated_at: '2025-06-15T00:00:00.000Z' },
}

const branchPayload: BranchPerformanceResponseType = {
  data: [
    {
      soffice_id: 's-1',
      soffice_name: 'Jakarta Pusat',
      rank: 1,
      total_visits: 300,
      total_revenue: 90_000_000,
      strike_rate_pct: 42.5,
      SALESMAN: { total_visits: 180, effective_calls: 160, call_rate_pct: 88 },
      MR: { total_visits: 120, effective_calls: 100, call_rate_pct: 83 },
    },
  ],
  meta: { month: 6, year: 2025, total_branches: 1 },
}

const callRatePayload: CallRateReportResponseType = {
  data: [
    {
      user_id: 'u-1',
      user_name: 'Budi',
      role_label: 'SALESMAN',
      soffice_id: 's-1',
      total_planned: 20,
      total_visited: 18,
      call_rate_pct: 90,
    },
  ],
  meta: { month: 6, year: 2025, total_users: 1 },
}

describe('report/excelExport — table builders', () => {
  it('flattens dashboard KPI into a Metric/Value table', () => {
    const table = buildDashboardKpiTable(dashboardPayload)
    expect(table.header).toEqual(['Metric', 'Value'])
    expect(table.rows).toContainEqual(['Total Orders', 340])
    expect(table.rows).toContainEqual(['MR Call Rate %', 80])
  })

  it('projects branch performance rows with role-segmented columns', () => {
    const table = buildBranchPerformanceTable(branchPayload)
    expect(table.header).toContain('Salesman Visits')
    expect(table.header).toContain('MR Call Rate %')
    expect(table.rows).toHaveLength(1)
    // rank, branch name, ... salesman visits at index 5
    expect(table.rows[0]![1]).toBe('Jakarta Pusat')
    expect(table.rows[0]![5]).toBe(180)
  })

  it('projects call-rate rows in order', () => {
    const table = buildCallRateTable(callRatePayload)
    expect(table.header).toEqual([
      'User',
      'Role',
      'Planned',
      'Visited',
      'Call Rate %',
    ])
    expect(table.rows[0]).toEqual(['Budi', 'SALESMAN', 20, 18, 90])
  })
})

describe('report/excelExport — serializeWorkbook', () => {
  it('produces a valid xlsx buffer that round-trips back to the same rows', async () => {
    const table = buildCallRateTable(callRatePayload)
    const buffer = await serializeWorkbook(table, 'call-rate')

    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.length).toBeGreaterThan(0)

    const parsed = XLSX.read(buffer, { type: 'buffer' })
    const sheet = parsed.Sheets[parsed.SheetNames[0]!]!
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
    expect(aoa[0]).toEqual(['User', 'Role', 'Planned', 'Visited', 'Call Rate %'])
    expect(aoa[1]).toEqual(['Budi', 'SALESMAN', 20, 18, 90])
  })
})

describe('report/excelExport — filename & MIME helpers', () => {
  it('builds a dated xlsx filename', () => {
    const name = buildExportFilename('call-rate', 'xlsx')
    expect(name).toMatch(/^call-rate_\d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('uses the OpenXML spreadsheet MIME type', () => {
    expect(XLSX_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })
})
