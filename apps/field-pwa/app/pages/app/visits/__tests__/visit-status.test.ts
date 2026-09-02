import { describe, expect, it } from 'vitest'
import type { LocalOutboxMutation, VisitPlan } from '@maction/types'
import { SyncStatus, UserRole } from '@maction/types'
import {
  VisitListStatus,
  deriveVisitStatus,
  toPlanDate,
  visitStatusPresentation
} from '../visit-status'

/** Build a minimal plan fixture; overrides tailor a single field per assertion. */
function makePlan(overrides: Partial<VisitPlan> = {}): VisitPlan {
  return {
    id: 'plan-1',
    company_id: 'co-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    outlet_context_id: null,
    plan_date: '2025-01-15',
    notes: null,
    is_completed: false,
    created_at: '2025-01-15T00:00:00.000Z',
    updated_at: '2025-01-15T00:00:00.000Z',
    ...overrides
  }
}

/** Build a pending outbox mutation targeting a customer with a given visit mutation type. */
function makeMutation(
  mutationType: LocalOutboxMutation['mutation_type'],
  customerId: string
): LocalOutboxMutation {
  return {
    id: `mut-${mutationType}-${customerId}`,
    company_id: 'co-1',
    user_id: 'user-1',
    user_role: UserRole.SALESMAN,
    mutation_type: mutationType,
    endpoint: '/visits/start',
    http_method: 'POST',
    payload: { customer_id: customerId },
    sync_status: SyncStatus.PENDING,
    captured_at: '2025-01-15T01:00:00.000Z',
    mono_delta_ms: 0,
    synced_at: null,
    error_message: null,
    retry_count: 0
  }
}

describe('deriveVisitStatus', () => {
  it('should be PLANNED when not completed and no pending visit mutation exists', () => {
    expect(deriveVisitStatus(makePlan(), [])).toBe(VisitListStatus.PLANNED)
  })

  it('should be COMPLETED when the plan is flagged is_completed', () => {
    expect(deriveVisitStatus(makePlan({ is_completed: true }), [])).toBe(VisitListStatus.COMPLETED)
  })

  it('should be IN_PROGRESS when a pending VISIT_IN targets the plan customer', () => {
    const pending = [makeMutation('VISIT_IN', 'cust-1')]
    expect(deriveVisitStatus(makePlan(), pending)).toBe(VisitListStatus.IN_PROGRESS)
  })

  it('should be COMPLETED when a pending VISIT_OUT targets the plan customer', () => {
    const pending = [makeMutation('VISIT_IN', 'cust-1'), makeMutation('VISIT_OUT', 'cust-1')]
    expect(deriveVisitStatus(makePlan(), pending)).toBe(VisitListStatus.COMPLETED)
  })

  it('should ignore pending mutations that target a different customer', () => {
    const pending = [makeMutation('VISIT_IN', 'cust-other')]
    expect(deriveVisitStatus(makePlan(), pending)).toBe(VisitListStatus.PLANNED)
  })
})

describe('visitStatusPresentation', () => {
  it('should present PLANNED in the primary color', () => {
    const presentation = visitStatusPresentation(VisitListStatus.PLANNED)
    expect(presentation.color).toBe('primary')
    expect(presentation.label).toBe('Direncanakan')
  })

  it('should present IN_PROGRESS in the warning color', () => {
    const presentation = visitStatusPresentation(VisitListStatus.IN_PROGRESS)
    expect(presentation.color).toBe('warning')
    expect(presentation.label).toBe('Berlangsung')
  })

  it('should present COMPLETED in the success color', () => {
    const presentation = visitStatusPresentation(VisitListStatus.COMPLETED)
    expect(presentation.color).toBe('success')
    expect(presentation.label).toBe('Selesai')
  })
})

describe('toPlanDate', () => {
  it('should format a date as a zero-padded local YYYY-MM-DD string', () => {
    expect(toPlanDate(new Date(2025, 0, 5))).toBe('2025-01-05')
    expect(toPlanDate(new Date(2025, 11, 25))).toBe('2025-12-25')
  })
})
