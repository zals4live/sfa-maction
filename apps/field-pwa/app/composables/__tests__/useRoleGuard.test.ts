import { describe, expect, it } from 'vitest'
import { UserRole } from '@maction/types'
import {
  InVisitStep,
  MR_IN_VISIT_STEPS,
  SALESMAN_IN_VISIT_STEPS,
  useRoleGuard,
  type RoleProvider
} from '../useRoleGuard'

/** Build a role guard wired to a fixed injected role (never touches the store/Nuxt). */
function guardFor(role: UserRole | null): ReturnType<typeof useRoleGuard> {
  return useRoleGuard({ getRole: () => role })
}

describe('useRoleGuard', () => {
  it('should expose the documented ordered step sequences per role', () => {
    expect(SALESMAN_IN_VISIT_STEPS).toEqual([
      InVisitStep.DETAILING,
      InVisitStep.COMPETITOR,
      InVisitStep.STOCK_AUDIT,
      InVisitStep.TAKING_ORDER
    ])
    expect(MR_IN_VISIT_STEPS).toEqual([
      InVisitStep.DETAILING,
      InVisitStep.PRICE_STOCK_LOOKUP,
      InVisitStep.COMPETITOR
    ])
  })

  describe('SALESMAN', () => {
    it('should identify the role and permit order taking', () => {
      const guard = guardFor(UserRole.SALESMAN)
      expect(guard.role.value).toBe(UserRole.SALESMAN)
      expect(guard.isSalesman.value).toBe(true)
      expect(guard.isMr.value).toBe(false)
      expect(guard.canTakeOrder.value).toBe(true)
      expect(guard.showOrderTab.value).toBe(true)
    })

    it('should include the Taking Order step in visit order', () => {
      const guard = guardFor(UserRole.SALESMAN)
      expect(guard.inVisitSteps.value).toEqual(SALESMAN_IN_VISIT_STEPS)
      expect(guard.inVisitSteps.value).toContain(InVisitStep.TAKING_ORDER)
      expect(guard.inVisitSteps.value).not.toContain(InVisitStep.PRICE_STOCK_LOOKUP)
    })
  })

  describe('MR', () => {
    it('should identify the role and forbid order taking', () => {
      const guard = guardFor(UserRole.MR)
      expect(guard.role.value).toBe(UserRole.MR)
      expect(guard.isMr.value).toBe(true)
      expect(guard.isSalesman.value).toBe(false)
      expect(guard.canTakeOrder.value).toBe(false)
      expect(guard.showOrderTab.value).toBe(false)
    })

    it('should replace Taking Order with a read-only Price/Stock lookup step', () => {
      const guard = guardFor(UserRole.MR)
      expect(guard.inVisitSteps.value).toEqual(MR_IN_VISIT_STEPS)
      expect(guard.inVisitSteps.value).not.toContain(InVisitStep.TAKING_ORDER)
      expect(guard.inVisitSteps.value).toContain(InVisitStep.PRICE_STOCK_LOOKUP)
    })
  })

  describe('unknown / logged-out role', () => {
    it('should default to a null role with no order access and no steps', () => {
      const guard = guardFor(null)
      expect(guard.role.value).toBeNull()
      expect(guard.isSalesman.value).toBe(false)
      expect(guard.isMr.value).toBe(false)
      expect(guard.canTakeOrder.value).toBe(false)
      expect(guard.showOrderTab.value).toBe(false)
      expect(guard.inVisitSteps.value).toEqual([])
    })

    it('should treat an admin role as unable to take orders (field-only gate)', () => {
      const guard = guardFor(UserRole.ADMIN_CABANG)
      expect(guard.canTakeOrder.value).toBe(false)
      expect(guard.showOrderTab.value).toBe(false)
      expect(guard.inVisitSteps.value).toEqual([])
    })
  })

  it('should re-read the role source on refresh (login/logout transitions)', () => {
    let current: UserRole | null = null
    const getRole: RoleProvider = () => current
    const guard = useRoleGuard({ getRole })

    expect(guard.role.value).toBeNull()
    expect(guard.canTakeOrder.value).toBe(false)

    current = UserRole.SALESMAN
    guard.refresh()

    expect(guard.role.value).toBe(UserRole.SALESMAN)
    expect(guard.canTakeOrder.value).toBe(true)
    expect(guard.inVisitSteps.value).toContain(InVisitStep.TAKING_ORDER)
  })

  it('should degrade to a null role off-store when no getter is injected', () => {
    // No global useAuthStore is registered in the test env, so the default provider
    // must degrade gracefully rather than throw.
    const guard = useRoleGuard()
    expect(guard.role.value).toBeNull()
    expect(guard.canTakeOrder.value).toBe(false)
    expect(guard.inVisitSteps.value).toEqual([])
  })
})
