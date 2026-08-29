import { describe, it, expect, beforeEach } from 'bun:test'

import {
  resolveStepProgression,
  appendLifecycleStep,
  recordLifecycleStep,
  VisitLifecycleStep,
  type LifecycleContext,
} from '../visitLifecycleService'

const baseCtx: LifecycleContext = {
  companyId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  userRole: 'SALESMAN',
}

const VISIT_ID = '33333333-3333-3333-3333-333333333333'

// =============================================================================
// Mock transaction helpers
// =============================================================================

/** Row shape returned by the "previous step" lookup in resolveStepProgression. */
interface PrevStepRow {
  stepSequence: number
  stepTimestamp: string
}

/** Captures the values passed to tx.insert().values(). */
interface InsertCapture {
  called: boolean
  row: Record<string, unknown> | null
}

/**
 * Builds a mock tx whose select chain returns `prevRows` (empty = first step)
 * and whose insert chain captures the inserted row. Optionally throws on insert
 * to simulate an audit-layer DB failure.
 */
function createMockTx(prevRows: PrevStepRow[], opts: { throwOnInsert?: boolean } = {}) {
  const capture: InsertCapture = { called: false, row: null }

  const selectChain = {
    select: () => selectChain,
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve(prevRows),
  }

  const tx = {
    ...selectChain,
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (opts.throwOnInsert) throw new Error('db failure')
        capture.called = true
        capture.row = row
        return Promise.resolve()
      },
    }),
  }

  return { tx, capture }
}

// =============================================================================
// resolveStepProgression
// =============================================================================

describe('visitLifecycleService/resolveStepProgression', () => {
  it('returns sequence 1 and null duration for the first step', async () => {
    const { tx } = createMockTx([])

    const progression = await resolveStepProgression(
      tx as never,
      baseCtx.companyId,
      VISIT_ID,
      '2024-01-01T08:00:00.000Z'
    )

    expect(progression.stepSequence).toBe(1)
    expect(progression.durationFromPrevMs).toBeNull()
  })

  it('increments sequence and computes duration from the previous step', async () => {
    const { tx } = createMockTx([
      { stepSequence: 2, stepTimestamp: '2024-01-01T08:00:00.000Z' },
    ])

    const progression = await resolveStepProgression(
      tx as never,
      baseCtx.companyId,
      VISIT_ID,
      '2024-01-01T08:05:00.000Z' // +5 min
    )

    expect(progression.stepSequence).toBe(3)
    expect(progression.durationFromPrevMs).toBe(5 * 60 * 1000)
  })
})

// =============================================================================
// appendLifecycleStep
// =============================================================================

describe('visitLifecycleService/appendLifecycleStep', () => {
  it('records the tenant, user, step name, sequence and timestamp', async () => {
    const { tx, capture } = createMockTx([])

    await appendLifecycleStep(tx as never, baseCtx, {
      visitId: VISIT_ID,
      stepName: VisitLifecycleStep.VISIT_IN,
      stepTimestamp: '2024-01-01T08:00:00.000Z',
    })

    expect(capture.called).toBe(true)
    const row = capture.row!
    expect(row.companyId).toBe(baseCtx.companyId)
    expect(row.userId).toBe(baseCtx.userId)
    expect(row.visitId).toBe(VISIT_ID)
    expect(row.stepName).toBe('VISIT_IN')
    expect(row.stepSequence).toBe(1)
    expect(row.durationFromPrevMs).toBeNull()
    expect(row.stepTimestamp).toBe('2024-01-01T08:00:00.000Z')
  })

  it('records geom when coordinates are provided', async () => {
    const { tx, capture } = createMockTx([])

    await appendLifecycleStep(tx as never, baseCtx, {
      visitId: VISIT_ID,
      stepName: VisitLifecycleStep.VISIT_OUT,
      coordinates: { latitude: -6.2, longitude: 106.8 },
    })

    // geom is a Drizzle SQL expression (ST_SetSRID(...)) — non-null when coords given.
    expect(capture.row!.geom).not.toBeNull()
  })

  it('leaves geom null when no coordinates are provided (e.g. detailing step)', async () => {
    const { tx, capture } = createMockTx([])

    await appendLifecycleStep(tx as never, baseCtx, {
      visitId: VISIT_ID,
      stepName: VisitLifecycleStep.DETAILING,
    })

    expect(capture.row!.geom).toBeNull()
  })

  it('works for the MR role identically to Salesman (role-agnostic stream)', async () => {
    const { tx, capture } = createMockTx([
      { stepSequence: 1, stepTimestamp: '2024-01-01T08:00:00.000Z' },
    ])

    await appendLifecycleStep(
      tx as never,
      { ...baseCtx, userRole: 'MR' },
      {
        visitId: VISIT_ID,
        stepName: VisitLifecycleStep.COMPETITOR_AUDIT,
        stepTimestamp: '2024-01-01T08:03:00.000Z',
      }
    )

    const row = capture.row!
    expect(row.stepName).toBe('COMPETITOR_AUDIT')
    expect(row.stepSequence).toBe(2)
    expect(row.durationFromPrevMs).toBe(3 * 60 * 1000)
  })
})

// =============================================================================
// recordLifecycleStep (best-effort, non-fatal)
// =============================================================================

describe('visitLifecycleService/recordLifecycleStep', () => {
  let originalError: typeof console.error

  beforeEach(() => {
    originalError = console.error
  })

  it('does not throw when the audit insert fails (never breaks the visit op)', async () => {
    console.error = () => {} // silence expected log line
    const { tx } = createMockTx([], { throwOnInsert: true })

    let threw = false
    try {
      await recordLifecycleStep(tx as never, baseCtx, {
        visitId: VISIT_ID,
        stepName: VisitLifecycleStep.VISIT_IN,
      })
    } catch {
      threw = true
    } finally {
      console.error = originalError
    }

    expect(threw).toBe(false)
  })

  it('appends the step on the happy path', async () => {
    const { tx, capture } = createMockTx([])

    await recordLifecycleStep(tx as never, baseCtx, {
      visitId: VISIT_ID,
      stepName: VisitLifecycleStep.STOCK_AUDIT,
    })

    expect(capture.called).toBe(true)
    expect(capture.row!.stepName).toBe('STOCK_AUDIT')
  })
})
