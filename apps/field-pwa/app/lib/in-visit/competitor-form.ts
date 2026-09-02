/**
 * Pure form logic for the in-visit competitor audit form (`CompetitorForm.vue`).
 *
 * Extracted from the SFC so the validation + payload-building rules can be unit tested in
 * the framework-agnostic `node` Vitest environment (the PWA has no DOM test harness). The
 * component stays a thin presentational shell that binds inputs to `CompetitorFormState` and
 * delegates every decision here.
 *
 * The payload mirrors the backend competitor-audit contract exactly (see
 * `services/api-server/src/modules/visit/schemas.ts` → `CreateCompetitorAuditBody`):
 * `competitor_brand` and `competitor_product` are required; `price_to_pharmacy`,
 * `consumer_price`, and `active_promo_notes` are optional and sent as `null` when empty.
 * `photo_s3_key` is uploaded separately via S3 pre-signed URLs, so it is intentionally out
 * of scope for this text form (mirrors `agenda-form.ts`).
 */

/** Max length of the competitor brand, matching `varchar(150)` on the backend. */
export const COMPETITOR_BRAND_MAX_LENGTH = 150

/** Max length of the competitor product, matching `varchar(150)` on the backend. */
export const COMPETITOR_PRODUCT_MAX_LENGTH = 150

/** Reactive form fields captured by `CompetitorForm.vue`. */
export interface CompetitorFormState {
  /** Competitor brand — required, trimmed, max 150 chars. */
  competitorBrand: string
  /** Competitor product — required, trimmed, max 150 chars. */
  competitorProduct: string
  /** Optional price to pharmacy, or `null` when not captured. Must be `>= 0` when set. */
  priceToPharmacy: number | null
  /** Optional consumer price, or `null` when not captured. Must be `>= 0` when set. */
  consumerPrice: number | null
  /** Optional free-text notes about active competitor promotions. */
  activePromoNotes: string
}

/**
 * Request body for `POST /visits/:id/competitor-audits`. Uses backend snake_case field names
 * so it can be sent straight through `useApiClient.post` / queued into the offline outbox
 * unchanged.
 */
export interface CreateCompetitorAuditPayload {
  competitor_brand: string
  competitor_product: string
  price_to_pharmacy: number | null
  consumer_price: number | null
  active_promo_notes: string | null
}

/** A field-keyed set of validation messages; empty object means the form is valid. */
export type CompetitorFormErrors = Partial<Record<keyof CompetitorFormState, string>>

/** A blank form state — the initial value and the post-submit reset target. */
export function createEmptyCompetitorForm(): CompetitorFormState {
  return {
    competitorBrand: '',
    competitorProduct: '',
    priceToPharmacy: null,
    consumerPrice: null,
    activePromoNotes: ''
  }
}

/** Normalize an optional text field: trim, and collapse an empty string to `null`. */
function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Validate a required, length-bounded text field into the errors map. */
function validateRequiredText(
  value: string,
  maxLength: number,
  requiredMessage: string,
  maxLengthMessage: string
): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return requiredMessage
  }
  if (trimmed.length > maxLength) {
    return maxLengthMessage
  }
  return undefined
}

/**
 * Validate the form against the backend `CreateCompetitorAuditBody` rules. Returns a map of
 * per-field messages; an empty map indicates the form may be submitted.
 */
export function validateCompetitorForm(state: CompetitorFormState): CompetitorFormErrors {
  const errors: CompetitorFormErrors = {}
  const brand = validateRequiredText(
    state.competitorBrand,
    COMPETITOR_BRAND_MAX_LENGTH,
    'Merek kompetitor wajib diisi.',
    `Merek kompetitor maksimal ${COMPETITOR_BRAND_MAX_LENGTH} karakter.`
  )
  if (brand) errors.competitorBrand = brand
  const product = validateRequiredText(
    state.competitorProduct,
    COMPETITOR_PRODUCT_MAX_LENGTH,
    'Produk kompetitor wajib diisi.',
    `Produk kompetitor maksimal ${COMPETITOR_PRODUCT_MAX_LENGTH} karakter.`
  )
  if (product) errors.competitorProduct = product
  if (state.priceToPharmacy !== null && state.priceToPharmacy < 0) {
    errors.priceToPharmacy = 'Harga tidak boleh negatif.'
  }
  if (state.consumerPrice !== null && state.consumerPrice < 0) {
    errors.consumerPrice = 'Harga tidak boleh negatif.'
  }
  return errors
}

/** Whether the form currently passes validation. */
export function isCompetitorFormValid(state: CompetitorFormState): boolean {
  return Object.keys(validateCompetitorForm(state)).length === 0
}

/**
 * Build the `POST /visits/:id/competitor-audits` payload from a validated form state. Trims
 * the brand/product, collapses empty notes to `null`, and passes numeric prices through
 * unchanged (`null` stays `null`) so the request matches the backend contract.
 */
export function buildCompetitorAuditPayload(state: CompetitorFormState): CreateCompetitorAuditPayload {
  return {
    competitor_brand: state.competitorBrand.trim(),
    competitor_product: state.competitorProduct.trim(),
    price_to_pharmacy: state.priceToPharmacy,
    consumer_price: state.consumerPrice,
    active_promo_notes: normalizeOptionalText(state.activePromoNotes)
  }
}
