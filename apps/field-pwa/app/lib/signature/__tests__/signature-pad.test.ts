import { describe, expect, it } from 'vitest'
import {
  appendPoint,
  beginStroke,
  countSignaturePoints,
  createEmptySignature,
  isSignatureEmpty,
  toCanvasPoint,
  type SignatureStrokes
} from '../signature-pad'

describe('signature-pad', () => {
  describe('createEmptySignature', () => {
    it('should start with no strokes', () => {
      expect(createEmptySignature()).toEqual([])
    })
  })

  describe('isSignatureEmpty', () => {
    it('should be true for a fresh signature', () => {
      expect(isSignatureEmpty(createEmptySignature())).toBe(true)
    })

    it('should be true when strokes exist but contain no points', () => {
      expect(isSignatureEmpty([[]])).toBe(true)
    })

    it('should be false once a single point (a dot) is drawn', () => {
      const strokes = beginStroke(createEmptySignature(), { x: 5, y: 5 })
      expect(isSignatureEmpty(strokes)).toBe(false)
    })
  })

  describe('countSignaturePoints', () => {
    it('should sum points across all strokes', () => {
      let strokes = beginStroke(createEmptySignature(), { x: 0, y: 0 })
      strokes = appendPoint(strokes, { x: 1, y: 1 })
      strokes = beginStroke(strokes, { x: 2, y: 2 })
      expect(countSignaturePoints(strokes)).toBe(3)
    })

    it('should be zero for an empty signature', () => {
      expect(countSignaturePoints(createEmptySignature())).toBe(0)
    })
  })

  describe('beginStroke', () => {
    it('should append a new stroke seeded with the first point', () => {
      const strokes = beginStroke([[{ x: 1, y: 1 }]], { x: 9, y: 9 })
      expect(strokes).toHaveLength(2)
      expect(strokes[1]).toEqual([{ x: 9, y: 9 }])
    })
  })

  describe('appendPoint', () => {
    it('should add the point to the last (in-progress) stroke', () => {
      const strokes = appendPoint([[{ x: 1, y: 1 }]], { x: 2, y: 2 })
      expect(strokes[0]).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }])
    })

    it('should seed a new stroke when none has been started', () => {
      const strokes = appendPoint(createEmptySignature(), { x: 4, y: 4 })
      expect(strokes).toEqual([[{ x: 4, y: 4 }]])
    })

    it('should not mutate the input strokes (pure)', () => {
      const input: SignatureStrokes = [[{ x: 1, y: 1 }]]
      appendPoint(input, { x: 2, y: 2 })
      expect(input).toEqual([[{ x: 1, y: 1 }]])
    })
  })

  describe('toCanvasPoint', () => {
    it('should map viewport coords relative to the element origin when unscaled', () => {
      const rect = { left: 10, top: 20, width: 300, height: 150 }
      const point = toCanvasPoint(40, 50, rect, 300, 150)
      expect(point).toEqual({ x: 30, y: 30 })
    })

    it('should scale coords when the canvas backing resolution differs from its CSS size', () => {
      // CSS box is 300x150, backing store is 600x300 → 2x scale on both axes.
      const rect = { left: 0, top: 0, width: 300, height: 150 }
      const point = toCanvasPoint(30, 15, rect, 600, 300)
      expect(point).toEqual({ x: 60, y: 30 })
    })

    it('should avoid divide-by-zero when the element has no size', () => {
      const rect = { left: 0, top: 0, width: 0, height: 0 }
      const point = toCanvasPoint(5, 7, rect, 600, 300)
      expect(point).toEqual({ x: 5, y: 7 })
    })
  })
})
