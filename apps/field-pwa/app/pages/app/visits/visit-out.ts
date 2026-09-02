/**
 * Pure helpers for the visit-out (visit completion) page (`[id]/visit-out.vue`).
 *
 * Extracted from the SFC (mirroring the sibling `visit-in.ts` pattern) so the non-trivial,
 * browser-free logic — the submit-gating decision — can be unit-tested in a node environment
 * without mounting the signature canvas or a Vue component. The page consumes this directly.
 *
 * Visit-out is role-agnostic: both SALESMAN and MR complete visits, so nothing here gates on
 * role. Unlike visit-in there is no geofence radius gate at completion; the trust gate is a
 * captured signature plus a trustworthy GPS fix.
 */

/** Preconditions that gate the "Visit Out" submit action. */
export interface VisitOutGateInput {
  /** The digital signature has been captured and uploaded to S3 (an `s3_key` is present). */
  hasSignature: boolean
  /** A trustworthy GPS fix has passed the anti-spoof accuracy/mock window. */
  hasValidFix: boolean
  /** A submit is already in flight. */
  submitting: boolean
}

/**
 * Decide whether the visit-out submit is allowed. Requires a captured/uploaded signature, a
 * trustworthy GPS fix (passes the anti-spoof accuracy window), and no in-flight submit. Kept
 * pure so the gating rule is unit-tested independently of the SFC and the signature canvas.
 */
export function canSubmitVisitOut(input: VisitOutGateInput): boolean {
  return input.hasSignature && input.hasValidFix && !input.submitting
}
