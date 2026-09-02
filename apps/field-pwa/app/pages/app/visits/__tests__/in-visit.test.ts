import { describe, expect, it } from 'vitest'
import {
  InVisitStep,
  MR_IN_VISIT_STEPS,
  SALESMAN_IN_VISIT_STEPS
} from '../../../../composables/useRoleGuard'
import {
  buildInVisitTabs,
  inVisitSlotName,
  inVisitStepPresentation
} from '../[id]/in-visit'

describe('inVisitStepPresentation', () => {
  it('should map every step to an Indonesian label and an icon', () => {
    const steps = [
      InVisitStep.DETAILING,
      InVisitStep.COMPETITOR,
      InVisitStep.STOCK_AUDIT,
      InVisitStep.TAKING_ORDER,
      InVisitStep.PRICE_STOCK_LOOKUP
    ]
    for (const step of steps) {
      const presentation = inVisitStepPresentation(step)
      expect(presentation.step).toBe(step)
      expect(presentation.label.length).toBeGreaterThan(0)
      expect(presentation.icon).toMatch(/^i-lucide-/)
    }
  })

  it('should use the documented Indonesian labels per step', () => {
    expect(inVisitStepPresentation(InVisitStep.DETAILING).label).toBe('Detailing')
    expect(inVisitStepPresentation(InVisitStep.COMPETITOR).label).toBe('Kompetitor')
    expect(inVisitStepPresentation(InVisitStep.STOCK_AUDIT).label).toBe('Audit Stok')
    expect(inVisitStepPresentation(InVisitStep.TAKING_ORDER).label).toBe('Ambil Order')
    expect(inVisitStepPresentation(InVisitStep.PRICE_STOCK_LOOKUP).label).toBe('Info Harga & Stok')
  })
})

describe('inVisitSlotName', () => {
  it('should derive a lowercased slot name from the step key', () => {
    expect(inVisitSlotName(InVisitStep.DETAILING)).toBe('detailing')
    expect(inVisitSlotName(InVisitStep.PRICE_STOCK_LOOKUP)).toBe('price_stock_lookup')
  })
})

describe('buildInVisitTabs', () => {
  it('should preserve the SALESMAN step ordering (detailing → competitor → stock → order)', () => {
    const tabs = buildInVisitTabs(SALESMAN_IN_VISIT_STEPS)
    expect(tabs.map(tab => tab.value)).toEqual([
      InVisitStep.DETAILING,
      InVisitStep.COMPETITOR,
      InVisitStep.STOCK_AUDIT,
      InVisitStep.TAKING_ORDER
    ])
  })

  it('should preserve the MR step ordering (detailing → price/stock → competitor)', () => {
    const tabs = buildInVisitTabs(MR_IN_VISIT_STEPS)
    expect(tabs.map(tab => tab.value)).toEqual([
      InVisitStep.DETAILING,
      InVisitStep.PRICE_STOCK_LOOKUP,
      InVisitStep.COMPETITOR
    ])
  })

  it('should decorate each tab with label, icon, value and a matching content slot', () => {
    const tabs = buildInVisitTabs(SALESMAN_IN_VISIT_STEPS)
    for (const tab of tabs) {
      const presentation = inVisitStepPresentation(tab.value)
      expect(tab.label).toBe(presentation.label)
      expect(tab.icon).toBe(presentation.icon)
      expect(tab.slot).toBe(inVisitSlotName(tab.value))
    }
  })

  it('should never expose the Taking Order tab for MR', () => {
    const tabs = buildInVisitTabs(MR_IN_VISIT_STEPS)
    expect(tabs.some(tab => tab.value === InVisitStep.TAKING_ORDER)).toBe(false)
  })

  it('should produce no tabs for an unknown role (empty step list)', () => {
    expect(buildInVisitTabs([])).toEqual([])
  })
})
