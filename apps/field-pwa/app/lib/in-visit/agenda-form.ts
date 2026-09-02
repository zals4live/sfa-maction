/**
 * Pure form logic for the in-visit detailing/agenda form (`AgendaForm.vue`).
 *
 * Extracted from the SFC so the validation + payload-building rules can be unit tested in
 * the framework-agnostic `node` Vitest environment (the PWA has no DOM test harness). The
 * component stays a thin presentational shell that binds inputs to `AgendaFormState` and
 * delegates every decision here.
 *
 * The payload mirrors the backend `visit_agendas` contract exactly (see
 * `services/api-server/src/modules/visit/schemas.ts` → `CreateAgendaBody`): `topic` is the
 * only required field; `product_discussed_id`, `discussion_summary`, and `photo_s3_key`
 * are all optional and sent as `null` when empty.
 */

/** Max length of the agenda topic, matching `varchar(255)` on `visit_agendas.topic`. */
export const AGENDA_TOPIC_MAX_LENGTH = 255

/** Reactive form fields captured by `AgendaForm.vue`. */
export interface AgendaFormState {
  /** Detailing topic — required, trimmed, max 255 chars. */
  topic: string
  /** Optional discussed product (master_material id), or `null` when none selected. */
  productDiscussedId: string | null
  /** Optional free-text discussion summary. */
  discussionSummary: string
}

/**
 * Request body for `POST /visits/:id/agendas`. Uses backend snake_case field names so it can
 * be sent straight through `useApiClient.post` / queued into the offline outbox unchanged.
 */
export interface CreateAgendaPayload {
  topic: string
  product_discussed_id: string | null
  discussion_summary: string | null
}

/** A field-keyed set of validation messages; empty object means the form is valid. */
export type AgendaFormErrors = Partial<Record<keyof AgendaFormState, string>>

/** A blank form state — the initial value and the post-submit reset target. */
export function createEmptyAgendaForm(): AgendaFormState {
  return {
    topic: '',
    productDiscussedId: null,
    discussionSummary: ''
  }
}

/** Normalize an optional text field: trim, and collapse an empty string to `null`. */
function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Validate the form against the backend `CreateAgendaBody` rules. Returns a map of
 * per-field messages; an empty map indicates the form may be submitted.
 */
export function validateAgendaForm(state: AgendaFormState): AgendaFormErrors {
  const errors: AgendaFormErrors = {}
  const topic = state.topic.trim()
  if (topic.length === 0) {
    errors.topic = 'Topik detailing wajib diisi.'
  } else if (topic.length > AGENDA_TOPIC_MAX_LENGTH) {
    errors.topic = `Topik maksimal ${AGENDA_TOPIC_MAX_LENGTH} karakter.`
  }
  return errors
}

/** Whether the form currently passes validation. */
export function isAgendaFormValid(state: AgendaFormState): boolean {
  return Object.keys(validateAgendaForm(state)).length === 0
}

/**
 * Build the `POST /visits/:id/agendas` payload from a validated form state. Trims the topic
 * and collapses empty optional fields to `null` so the request matches the backend contract.
 */
export function buildAgendaPayload(state: AgendaFormState): CreateAgendaPayload {
  return {
    topic: state.topic.trim(),
    product_discussed_id: normalizeOptionalText(state.productDiscussedId),
    discussion_summary: normalizeOptionalText(state.discussionSummary)
  }
}
