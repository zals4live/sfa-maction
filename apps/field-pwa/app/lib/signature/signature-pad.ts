/**
 * Pure geometry + state logic for the digital signature pad (`SignaturePad.vue`).
 *
 * Extracted from the SFC so the stroke-tracking, empty-signature guard, and coordinate
 * mapping rules can be unit tested in the framework-agnostic `node` Vitest environment
 * (the PWA has no DOM test harness). The component stays a thin shell that wires pointer
 * events + a `<canvas>` to these pure functions.
 *
 * A signature is modelled as a list of strokes; each stroke is an ordered list of points in
 * canvas pixel space. The pad is considered "empty" (save disabled) until at least one
 * stroke contains a drawn segment, mirroring the backend requirement that a visit-out
 * carries a non-empty `signature_s3_key` (see `EndVisitBody` in
 * `services/api-server/src/modules/visit/schemas.ts`).
 */

/** A single sampled point in canvas pixel space. */
export interface SignaturePoint {
  x: number
  y: number
}

/** One continuous pen stroke: the points captured between pointer-down and pointer-up. */
export type SignatureStroke = SignaturePoint[]

/** The full signature: an ordered list of strokes. */
export type SignatureStrokes = SignatureStroke[]

/**
 * Map a pointer event's viewport coordinates into canvas pixel space, accounting for the
 * element's on-screen size versus its backing pixel resolution (device-pixel-ratio scaling).
 * Returns integer-free floats suitable for smooth line drawing.
 */
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number, top: number, width: number, height: number },
  canvasWidth: number,
  canvasHeight: number
): SignaturePoint {
  const scaleX = rect.width === 0 ? 1 : canvasWidth / rect.width
  const scaleY = rect.height === 0 ? 1 : canvasHeight / rect.height
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  }
}

/** Whether a set of strokes contains any drawn line (a stroke with 2+ points, or a dot). */
export function isSignatureEmpty(strokes: SignatureStrokes): boolean {
  return !strokes.some(stroke => stroke.length >= 1)
}

/** Total number of sampled points across every stroke — used to gate the save action. */
export function countSignaturePoints(strokes: SignatureStrokes): number {
  return strokes.reduce((total, stroke) => total + stroke.length, 0)
}

/** Begin a new stroke seeded with its first point, returning the appended strokes list. */
export function beginStroke(strokes: SignatureStrokes, point: SignaturePoint): SignatureStrokes {
  return [...strokes, [point]]
}

/**
 * Append a point to the in-progress (last) stroke. If no stroke has been started, the point
 * seeds a new one so a lone move never mutates a non-existent stroke.
 */
export function appendPoint(strokes: SignatureStrokes, point: SignaturePoint): SignatureStrokes {
  if (strokes.length === 0) {
    return [[point]]
  }
  const head = strokes.slice(0, -1)
  const last = strokes[strokes.length - 1] ?? []
  return [...head, [...last, point]]
}

/** An empty signature — the initial value and the post-clear reset target. */
export function createEmptySignature(): SignatureStrokes {
  return []
}
