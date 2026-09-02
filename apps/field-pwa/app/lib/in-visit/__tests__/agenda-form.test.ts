import { describe, expect, it } from 'vitest'
import {
  AGENDA_TOPIC_MAX_LENGTH,
  buildAgendaPayload,
  createEmptyAgendaForm,
  isAgendaFormValid,
  validateAgendaForm,
  type AgendaFormState
} from '../agenda-form'

/** Build a form state from partial overrides atop a blank form. */
function formWith(overrides: Partial<AgendaFormState> = {}): AgendaFormState {
  return { ...createEmptyAgendaForm(), ...overrides }
}

describe('agenda-form', () => {
  describe('createEmptyAgendaForm', () => {
    it('should return a blank, submittable-once-filled state', () => {
      expect(createEmptyAgendaForm()).toEqual({
        topic: '',
        productDiscussedId: null,
        discussionSummary: ''
      })
    })
  })

  describe('validateAgendaForm', () => {
    it('should require a topic', () => {
      expect(validateAgendaForm(formWith({ topic: '' })).topic).toBeDefined()
      expect(validateAgendaForm(formWith({ topic: '   ' })).topic).toBeDefined()
    })

    it('should accept a valid topic with no errors', () => {
      expect(validateAgendaForm(formWith({ topic: 'Presentasi produk' }))).toEqual({})
    })

    it('should reject a topic longer than the backend varchar(255) limit', () => {
      const tooLong = 'a'.repeat(AGENDA_TOPIC_MAX_LENGTH + 1)
      expect(validateAgendaForm(formWith({ topic: tooLong })).topic).toBeDefined()
    })

    it('should accept a topic exactly at the max length', () => {
      const atLimit = 'a'.repeat(AGENDA_TOPIC_MAX_LENGTH)
      expect(validateAgendaForm(formWith({ topic: atLimit }))).toEqual({})
    })
  })

  describe('isAgendaFormValid', () => {
    it('should be false when the topic is blank and true once filled', () => {
      expect(isAgendaFormValid(formWith({ topic: '' }))).toBe(false)
      expect(isAgendaFormValid(formWith({ topic: 'Detailing' }))).toBe(true)
    })
  })

  describe('buildAgendaPayload', () => {
    it('should trim the topic and match the backend CreateAgendaBody contract', () => {
      const payload = buildAgendaPayload(
        formWith({
          topic: '  Detailing produk  ',
          productDiscussedId: 'mat-123',
          discussionSummary: '  Dokter tertarik  '
        })
      )
      expect(payload).toEqual({
        topic: 'Detailing produk',
        product_discussed_id: 'mat-123',
        discussion_summary: 'Dokter tertarik'
      })
    })

    it('should collapse empty optional fields to null', () => {
      const payload = buildAgendaPayload(formWith({ topic: 'Topik', discussionSummary: '   ' }))
      expect(payload.product_discussed_id).toBeNull()
      expect(payload.discussion_summary).toBeNull()
    })
  })
})
