/**
 * Pure form logic for the in-visit stock audit form (`StockAuditForm.vue`).
 *
 * Extracted from the SFC so the validation + payload-building rules can be unit tested in
 * the framework-agnostic `node` Vitest environment (the PWA has no DOM test harness). The
 * component stays a thin presentational shell that binds inputs to `StockAuditFormState` and
 * delegates every decision here.
 *
 * The payload mirrors the backend stock-audit contract exactly (see
 * `services/api-server/src/modules/visit/schemas.ts` → `CreateStockAuditBody`):
 * `material_id`, `physical_stock_qty`, and `uom` are required; `estimated_days_of_stock` is
 * optional and sent as `null` when not captured. Quantities are non-negative integers (the
 * backend uses `Type.Integer({ minimum: 0 })`), so this helper enforces integer + range
 * rules client-side to surface validation inline before submit.
 */

/** Max length of the UOM code, matching `varchar(20)` on the backend. */
export const STOCK_AUDIT_UOM_MAX_LENGTH = 20

/** Reactive form fields captured by `StockAuditForm.vue`. */
export interface StockAuditFormState {
  /** Audited material — required; the id of a lini-scoped `MasterMaterial`. */
  materialId: string | null
  /** Observed physical shelf stock — required, non-negative integer. */
  physicalStockQty: number | null
  /** Unit of measure for the observed quantity — required, max 20 chars. */
  uom: string
  /** Optional estimated days of stock remaining, or `null` when not captured. */
  estimatedDaysOfStock: number | null
}

/**
 * Request body for `POST /visits/:id/stock-audits`. Uses backend snake_case field names so
 * it can be sent straight through `useApiClient.post` / queued into the offline outbox
 * unchanged.
 */
export interface CreateStockAuditPayload {
  material_id: string
  physical_stock_qty: number
  uom: string
  estimated_days_of_stock: number | null
}

/** A field-keyed set of validation messages; empty object means the form is valid. */
export type StockAuditFormErrors = Partial<Record<keyof StockAuditFormState, string>>

/** A blank form state — the initial value and the post-submit reset target. */
export function createEmptyStockAuditForm(): StockAuditFormState {
  return {
    materialId: null,
    physicalStockQty: null,
    uom: '',
    estimatedDaysOfStock: null
  }
}

/** Validate a required, non-negative integer quantity, returning a message on failure. */
function validateRequiredQty(value: number | null): string | undefined {
  if (value === null) {
    return 'Jumlah stok fisik wajib diisi.'
  }
  if (!Number.isInteger(value)) {
    return 'Jumlah stok fisik harus berupa bilangan bulat.'
  }
  if (value < 0) {
    return 'Jumlah stok fisik tidak boleh negatif.'
  }
  return undefined
}

/** Validate the optional estimated-days-of-stock field, returning a message on failure. */
function validateEstimatedDays(value: number | null): string | undefined {
  if (value === null) {
    return undefined
  }
  if (!Number.isInteger(value)) {
    return 'Estimasi hari stok harus berupa bilangan bulat.'
  }
  if (value < 0) {
    return 'Estimasi hari stok tidak boleh negatif.'
  }
  return undefined
}

/**
 * Validate the form against the backend `CreateStockAuditBody` rules. Returns a map of
 * per-field messages; an empty map indicates the form may be submitted.
 */
export function validateStockAuditForm(state: StockAuditFormState): StockAuditFormErrors {
  const errors: StockAuditFormErrors = {}
  if (!state.materialId) {
    errors.materialId = 'Material wajib dipilih.'
  }
  const qty = validateRequiredQty(state.physicalStockQty)
  if (qty) errors.physicalStockQty = qty
  const uom = state.uom.trim()
  if (uom.length === 0) {
    errors.uom = 'Satuan (UOM) wajib diisi.'
  } else if (uom.length > STOCK_AUDIT_UOM_MAX_LENGTH) {
    errors.uom = `Satuan maksimal ${STOCK_AUDIT_UOM_MAX_LENGTH} karakter.`
  }
  const days = validateEstimatedDays(state.estimatedDaysOfStock)
  if (days) errors.estimatedDaysOfStock = days
  return errors
}

/** Whether the form currently passes validation. */
export function isStockAuditFormValid(state: StockAuditFormState): boolean {
  return Object.keys(validateStockAuditForm(state)).length === 0
}

/**
 * Build the `POST /visits/:id/stock-audits` payload from a validated form state. Assumes the
 * caller validated first (`materialId` non-null, `physicalStockQty` a valid integer); trims
 * the UOM and passes the optional estimate through unchanged (`null` stays `null`) so the
 * request matches the backend contract.
 */
export function buildStockAuditPayload(state: StockAuditFormState): CreateStockAuditPayload {
  return {
    material_id: state.materialId ?? '',
    physical_stock_qty: state.physicalStockQty ?? 0,
    uom: state.uom.trim(),
    estimated_days_of_stock: state.estimatedDaysOfStock
  }
}
