import { describe, expect, it } from 'vitest'
import { FraudType } from '@maction/types'
import {
  MAX_ACCURACY_METERS,
  MAX_CLOCK_DRIFT_MS,
  MIN_ACCURACY_METERS,
  useAntiSpoof,
  type EvaluatedPosition,
  type EvaluationRejected
} from '../useAntiSpoof'

/** A clean GPS fix near Jakarta with an accuracy inside the trusted window. */
const GOOD_FIX: EvaluatedPosition = { lat: -6.2, lng: 106.816666, accuracy: 10 }

/** Assert a result is a rejection of an expected fraud type and narrow it. */
function expectRejection(
  result: ReturnType<ReturnType<typeof useAntiSpoof>['evaluatePosition']>,
  fraudType: FraudType
): EvaluationRejected {
  expect(result.ok).toBe(false)
  const rejection = result as EvaluationRejected
  expect(rejection.fraudType).toBe(fraudType)
  return rejection
}

/** Build a controllable clock pair: mutate the returned object between calls. */
function fakeClocks(state: { wall: number, mono: number }) {
  return { now: () => state.wall, monotonic: () => state.mono }
}

describe('useAntiSpoof', () => {
  it('should expose the documented accuracy and drift thresholds', () => {
    expect(MIN_ACCURACY_METERS).toBe(3)
    expect(MAX_ACCURACY_METERS).toBe(50)
    expect(MAX_CLOCK_DRIFT_MS).toBe(30_000)
  })

  it('should accept a fix with accuracy inside the trusted window', () => {
    const guard = useAntiSpoof()
    expect(guard.evaluatePosition(GOOD_FIX)).toEqual({ ok: true })
    expect(guard.lastResult.value).toEqual({ ok: true })
  })

  it('should accept fixes exactly at the accuracy boundaries (inclusive)', () => {
    const guard = useAntiSpoof()
    expect(guard.evaluatePosition({ ...GOOD_FIX, accuracy: MIN_ACCURACY_METERS }).ok).toBe(true)
    expect(guard.evaluatePosition({ ...GOOD_FIX, accuracy: MAX_ACCURACY_METERS }).ok).toBe(true)
  })

  it('should reject a fix with accuracy tighter than the minimum', () => {
    const guard = useAntiSpoof()
    const result = guard.evaluatePosition({ ...GOOD_FIX, accuracy: 1 })
    expectRejection(result, FraudType.ACCURACY_EXCESS)
  })

  it('should reject a fix with accuracy looser than the maximum', () => {
    const guard = useAntiSpoof()
    const result = guard.evaluatePosition({ ...GOOD_FIX, accuracy: 120 })
    expectRejection(result, FraudType.ACCURACY_EXCESS)
  })

  it('should reject a position flagged with the `mocked` indicator', () => {
    const guard = useAntiSpoof()
    const result = guard.evaluatePosition({ ...GOOD_FIX, mocked: true })
    expectRejection(result, FraudType.MOCK_LOCATION)
  })

  it('should reject a position flagged with the `isMock` indicator', () => {
    const guard = useAntiSpoof()
    const result = guard.evaluatePosition({ ...GOOD_FIX, isMock: true })
    expectRejection(result, FraudType.MOCK_LOCATION)
  })

  it('should prioritize the mock flag over any accuracy problem', () => {
    const guard = useAntiSpoof()
    const result = guard.evaluatePosition({ ...GOOD_FIX, accuracy: 999, mocked: true })
    expectRejection(result, FraudType.MOCK_LOCATION)
  })

  it('should pass clock validation before any baseline is anchored', () => {
    const guard = useAntiSpoof()
    expect(guard.isAnchored.value).toBe(false)
    expect(guard.validateClock()).toEqual({ ok: true })
  })

  it('should accept consistent wall-clock and monotonic progression', () => {
    const state = { wall: 1_000, mono: 500 }
    const guard = useAntiSpoof(fakeClocks(state))
    guard.anchor()
    expect(guard.isAnchored.value).toBe(true)

    state.wall += 5_000
    state.mono += 5_000
    expect(guard.validateClock()).toEqual({ ok: true })
  })

  it('should flag clock drift when wall time diverges from monotonic beyond tolerance', () => {
    const state = { wall: 1_000, mono: 500 }
    const guard = useAntiSpoof(fakeClocks(state))
    guard.anchor()

    state.wall += 40_000 // wall jumps 40s
    state.mono += 5_000 // hardware only advanced 5s
    const result = guard.validateClock()
    expectRejection(result, FraudType.CLOCK_DRIFT)
  })

  it('should flag a backwards wall-clock jump as clock drift', () => {
    const state = { wall: 10_000, mono: 5_000 }
    const guard = useAntiSpoof(fakeClocks(state))
    guard.anchor()

    state.wall -= 1_000 // offline timestamp moved backwards
    state.mono += 1_000
    const result = guard.validateClock()
    expectRejection(result, FraudType.CLOCK_DRIFT)
  })

  it('should tolerate drift at exactly the maximum threshold', () => {
    const state = { wall: 0, mono: 0 }
    const guard = useAntiSpoof(fakeClocks(state))
    guard.anchor()

    state.wall += MAX_CLOCK_DRIFT_MS
    state.mono += 0 // divergence exactly MAX_CLOCK_DRIFT_MS
    expect(guard.validateClock()).toEqual({ ok: true })
  })

  it('should build a telemetry payload shaped for the fraud audit outbox', () => {
    const state = { wall: 1_700_000_000_000, mono: 12_345 }
    const guard = useAntiSpoof({
      ...fakeClocks(state),
      userAgent: () => 'test-agent/1.0'
    })
    const rejection = guard.evaluatePosition({ ...GOOD_FIX, accuracy: 200 }) as EvaluationRejected
    const telemetry = guard.buildTelemetry(rejection, { ...GOOD_FIX, accuracy: 200 })

    expect(telemetry).toEqual({
      fraud_type: FraudType.ACCURACY_EXCESS,
      claimed_lat: GOOD_FIX.lat,
      claimed_lng: GOOD_FIX.lng,
      accuracy_meters: 200,
      device_info: { userAgent: 'test-agent/1.0' },
      raw_payload: expect.objectContaining({ message: rejection.message }),
      wall_clock_ms: state.wall,
      monotonic_ms: state.mono
    })
  })

  it('should build telemetry with null coordinates when no position is supplied', () => {
    const guard = useAntiSpoof({ userAgent: () => null })
    guard.anchor()
    const rejection: EvaluationRejected = {
      ok: false,
      fraudType: FraudType.CLOCK_DRIFT,
      message: 'drift',
      details: { wall_elapsed_ms: 99_000 }
    }
    const telemetry = guard.buildTelemetry(rejection)

    expect(telemetry.claimed_lat).toBeNull()
    expect(telemetry.claimed_lng).toBeNull()
    expect(telemetry.accuracy_meters).toBeNull()
    expect(telemetry.device_info.userAgent).toBeNull()
  })
})
