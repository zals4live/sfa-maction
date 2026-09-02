import { describe, expect, it } from 'vitest'
import { canSubmitVisitOut } from '../visit-out'

describe('canSubmitVisitOut', () => {
  it('should allow submit with a signature, a valid fix, and not submitting', () => {
    expect(canSubmitVisitOut({ hasSignature: true, hasValidFix: true, submitting: false })).toBe(true)
  })

  it('should block submit when no signature has been captured', () => {
    expect(canSubmitVisitOut({ hasSignature: false, hasValidFix: true, submitting: false })).toBe(false)
  })

  it('should block submit without a trustworthy fix', () => {
    expect(canSubmitVisitOut({ hasSignature: true, hasValidFix: false, submitting: false })).toBe(false)
  })

  it('should block submit while a submit is already in flight', () => {
    expect(canSubmitVisitOut({ hasSignature: true, hasValidFix: true, submitting: true })).toBe(false)
  })
})
