import { describe, it, expect, mock } from 'bun:test'
import { setRLSContext, clearRLSContext, RLS_VARIABLES } from '../rls'
import type { RLSContext } from '../rls'

function createMockTransaction() {
  const calls: unknown[] = []
  return {
    calls,
    execute: mock((query: unknown) => {
      calls.push(query)
      return Promise.resolve()
    }),
  }
}

describe('RLS_VARIABLES', () => {
  it('contains correct PostgreSQL session variable names', () => {
    expect(RLS_VARIABLES.COMPANY_ID).toBe('app.current_company_id')
    expect(RLS_VARIABLES.USER_ID).toBe('app.current_user_id')
    expect(RLS_VARIABLES.USER_ROLE).toBe('app.current_user_role')
  })

  it('is frozen and immutable', () => {
    expect(Object.isFrozen(RLS_VARIABLES)).toBe(true)
  })
})

describe('setRLSContext', () => {
  it('executes three set_config calls on the transaction', async () => {
    const tx = createMockTransaction()
    const ctx: RLSContext = {
      companyId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '660e8400-e29b-41d4-a716-446655440001',
      userRole: 'SALESMAN',
    }

    await setRLSContext(tx, ctx)

    expect(tx.execute).toHaveBeenCalledTimes(3)
  })

  it('throws when companyId is empty', async () => {
    const tx = createMockTransaction()
    const ctx: RLSContext = { companyId: '', userId: 'some-id', userRole: 'SALESMAN' }

    expect(setRLSContext(tx, ctx)).rejects.toThrow('RLS context requires a non-empty companyId')
  })

  it('throws when userId is empty', async () => {
    const tx = createMockTransaction()
    const ctx: RLSContext = { companyId: 'some-id', userId: '', userRole: 'SALESMAN' }

    expect(setRLSContext(tx, ctx)).rejects.toThrow('RLS context requires a non-empty userId')
  })

  it('does not throw when userRole is empty (valid for reset scenarios)', async () => {
    const tx = createMockTransaction()
    const ctx: RLSContext = { companyId: 'some-id', userId: 'some-user', userRole: '' }

    await expect(setRLSContext(tx, ctx)).resolves.toBeUndefined()
    expect(tx.execute).toHaveBeenCalledTimes(3)
  })
})

describe('clearRLSContext', () => {
  it('executes three set_config calls to reset variables', async () => {
    const tx = createMockTransaction()

    await clearRLSContext(tx)

    expect(tx.execute).toHaveBeenCalledTimes(3)
  })
})
