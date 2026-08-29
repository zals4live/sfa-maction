import { and, eq, isNull, sql } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { buildIdempotencyKey, claimIdempotencyKey, IDEMPOTENCY_TTL_SECONDS } from './idempotency'
import { appUsers } from '../../db/schema/auth'
import { masterCustomer, doctorProfiles } from '../../db/schema/customer'
import { masterMaterial, masterPrice, stockInventoryAtp, masterPromotions } from '../../db/schema/material'
import { masterSoffice, masterLini, masterVarian } from '../../db/schema/tenant'
import { visitPlans } from '../../db/schema/visit'
import type {
  CustomerSyncInput,
  CustomerDelta,
  MaterialSyncInput,
  MaterialDelta,
  PriceSyncInput,
  PriceDelta,
  StockSyncInput,
  StockDelta,
  PromotionSyncInput,
  PromotionDelta,
  LeadSyncInput,
  LeadDelta,
  ErpSyncResult,
} from './schemas'

/** Structured error thrown by service functions for route-level handling. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

// =============================================================================
// Idempotency (cross-cutting) — Redis-backed at-most-once delivery.
//
// The shared idempotency layer lives in `./idempotency` and is used by both the
// inbound service (here) and the outbound order worker. Every inbound ERP batch
// carries an `idempotency_key`; before applying a batch the shared
// `claimIdempotencyKey` atomically claims the key in Redis (SET NX, 24h TTL). A
// failed claim means the key was already processed, so we short-circuit with a
// duplicate envelope and never re-run the upsert. This mirrors the security
// steering's at-most-once requirement for ERP integration.
//
// `buildIdempotencyKey` and `IDEMPOTENCY_TTL_SECONDS` are re-exported to keep a
// stable API surface for routes/tests that import them from this module.
// =============================================================================

export { buildIdempotencyKey, IDEMPOTENCY_TTL_SECONDS }

/** Builds the duplicate-delivery envelope for an already-processed batch. */
function duplicateResult(idempotencyKey: string, received: number): ErpSyncResult {
  return {
    data: {
      idempotency_key: idempotencyKey,
      duplicate: true,
      received,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    },
  }
}

/** Outcome of a per-record apply pass, before it's wrapped in the result envelope. */
interface ApplyOutcome {
  created: number
  updated: number
  failed: number
  errors: ErpSyncResult['data']['errors']
}

/** Wraps a fresh (non-duplicate) apply outcome in the standard result envelope. */
function buildResult(
  idempotencyKey: string,
  received: number,
  outcome: ApplyOutcome
): ErpSyncResult {
  return {
    data: {
      idempotency_key: idempotencyKey,
      duplicate: false,
      received,
      created: outcome.created,
      updated: outcome.updated,
      failed: outcome.failed,
      errors: outcome.errors,
    },
  }
}

/** Empty apply outcome used by the not-yet-implemented per-record upsert stubs. */
function emptyOutcome(): ApplyOutcome {
  return { created: 0, updated: 0, failed: 0, errors: [] }
}

/**
 * Shared sync driver: guards a batch with the idempotency claim, then delegates
 * the per-record upsert work to `apply`. On a duplicate key the apply step is
 * skipped and a duplicate envelope is returned; otherwise the apply outcome is
 * wrapped in a fresh result envelope. Individual `apply` implementations are the
 * downstream per-type tasks.
 */
async function runSync(
  companyId: string,
  scope: string,
  idempotencyKey: string,
  received: number,
  apply: () => Promise<ApplyOutcome>
): Promise<ErpSyncResult> {
  const claimed = await claimIdempotencyKey(companyId, scope, idempotencyKey)
  if (!claimed) {
    return duplicateResult(idempotencyKey, received)
  }

  const outcome = await apply()
  return buildResult(idempotencyKey, received, outcome)
}

// =============================================================================
// Per-type sync handlers.
//
// The idempotency guard is fully implemented here (shared cross-cutting logic).
// The per-record upsert algorithms are SEPARATE downstream Phase 9 tasks — each
// `apply` body is stubbed and returns the correct envelope shape so routes.ts
// compiles and is testable end-to-end. `companyId` is the tenant resolved from
// the authenticated Super Admin's JWT claims (also applied as RLS context).
// =============================================================================

/** Inbound customer/doctor delta sync — upsert matching erp_customer_code. */
export async function syncCustomers(
  tx: Transaction,
  companyId: string,
  input: CustomerSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'customers', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyCustomerDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single customer delta into the accumulating outcome. Resolves the
 * sales office, upserts the customer, then upserts the doctor profile when
 * applicable. Per-record failures are captured (never thrown) so one bad record
 * does not abort the batch.
 */
async function applyCustomerDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: CustomerDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const sofficeId = await resolveSofficeId(tx, companyId, record.soffice_code)
    if (!sofficeId) {
      outcome.failed++
      outcome.errors.push(customerError(index, record, 'SOFFICE_NOT_FOUND', `Sales office '${record.soffice_code}' not found`))
      return
    }
    await upsertCustomerRecord(tx, companyId, sofficeId, record, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(customerError(index, record, 'CUSTOMER_UPSERT_CONFLICT', `Concurrent upsert conflict for '${record.erp_customer_code}'`))
      return
    }
    outcome.failed++
    outcome.errors.push(customerError(index, record, 'CUSTOMER_UPSERT_FAILED', `Failed to upsert customer '${record.erp_customer_code}'`))
  }
}

/** Resolves a non-deleted sales office id by tenant + ERP code. Returns null when absent. */
async function resolveSofficeId(
  tx: Transaction,
  companyId: string,
  sofficeCode: string
): Promise<string | null> {
  const [row] = await tx
    .select({ id: masterSoffice.id })
    .from(masterSoffice)
    .where(
      and(
        eq(masterSoffice.companyId, companyId),
        eq(masterSoffice.code, sofficeCode),
        eq(masterSoffice.isDeleted, false)
      )
    )
  return row?.id ?? null
}

/** Builds a PostGIS point geometry when both coordinates are present, else null. */
function buildLocationGeom(record: CustomerDelta): ReturnType<typeof sql> | null {
  const { latitude, longitude } = record
  if (latitude == null || longitude == null) return null
  return sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`
}

/** Inserts or updates a master_customer row matched by (company_id, erp_customer_code). */
async function upsertCustomerRecord(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  record: CustomerDelta,
  outcome: ApplyOutcome
): Promise<void> {
  const [existing] = await tx
    .select({ id: masterCustomer.id })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.companyId, companyId),
        eq(masterCustomer.erpCustomerCode, record.erp_customer_code)
      )
    )

  const customerId = existing
    ? await updateCustomerRow(tx, existing.id, sofficeId, record)
    : await insertCustomerRow(tx, companyId, sofficeId, record)

  if (existing) outcome.updated++
  else outcome.created++

  if (record.customer_type === 'DOCTOR' && record.doctor_profile) {
    await upsertDoctorProfileDelta(tx, companyId, customerId, record.doctor_profile)
  }
}

/** Inserts a new master_customer row and returns its id. */
async function insertCustomerRow(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  record: CustomerDelta
): Promise<string> {
  const [row] = await tx
    .insert(masterCustomer)
    .values({
      companyId,
      sofficeId,
      customerType: record.customer_type,
      erpCustomerCode: record.erp_customer_code,
      name: record.name,
      customerGroup: record.customer_group ?? null,
      address: record.address ?? null,
      city: record.city ?? null,
      locationGeom: buildLocationGeom(record),
      creditLimit: record.credit_limit?.toString() ?? '0',
      creditTermDays: record.credit_term_days ?? 30,
      isActive: record.is_active ?? true,
    })
    .returning({ id: masterCustomer.id })

  if (!row) throw new Error('Insert returned no rows')
  return row.id
}

/** Updates the mutable fields of an existing master_customer row and returns its id. */
async function updateCustomerRow(
  tx: Transaction,
  customerId: string,
  sofficeId: string,
  record: CustomerDelta
): Promise<string> {
  const values: Record<string, unknown> = {
    sofficeId,
    customerType: record.customer_type,
    name: record.name,
    updatedAt: sql`NOW()`,
  }
  if (record.customer_group !== undefined) values.customerGroup = record.customer_group
  if (record.address !== undefined) values.address = record.address
  if (record.city !== undefined) values.city = record.city
  if (record.credit_limit !== undefined) values.creditLimit = record.credit_limit?.toString() ?? '0'
  if (record.credit_term_days !== undefined) values.creditTermDays = record.credit_term_days
  if (record.is_active !== undefined) values.isActive = record.is_active
  const geom = buildLocationGeom(record)
  if (geom !== null) values.locationGeom = geom

  await tx.update(masterCustomer).set(values).where(eq(masterCustomer.id, customerId))
  return customerId
}

/** Upserts doctor_profiles by customer_id for the ERP delta fields only. */
async function upsertDoctorProfileDelta(
  tx: Transaction,
  companyId: string,
  customerId: string,
  profile: NonNullable<CustomerDelta['doctor_profile']>
): Promise<void> {
  const [existing] = await tx
    .select({ id: doctorProfiles.id })
    .from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, customerId))

  if (existing) {
    const values: Record<string, unknown> = { updatedAt: sql`NOW()` }
    if (profile.sip_str_number !== undefined) values.sipStrNumber = profile.sip_str_number
    if (profile.specialization !== undefined) values.specialization = profile.specialization
    if (profile.sub_specialization !== undefined) values.subSpecialization = profile.sub_specialization
    if (profile.notes !== undefined) values.notes = profile.notes
    await tx.update(doctorProfiles).set(values).where(eq(doctorProfiles.id, existing.id))
    return
  }

  await tx.insert(doctorProfiles).values({
    companyId,
    customerId,
    sipStrNumber: profile.sip_str_number ?? null,
    specialization: profile.specialization ?? null,
    subSpecialization: profile.sub_specialization ?? null,
    notes: profile.notes ?? null,
  })
}

/** Builds a structured per-record sync error entry keyed by the ERP business key. */
function customerError(
  index: number,
  record: CustomerDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: record.erp_customer_code, code, message }
}

/** Detects a PostgreSQL unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === '23505'
}

/** Inbound material/SKU sync — upsert matching erp_material_code (with lini). */
export async function syncMaterials(
  tx: Transaction,
  companyId: string,
  input: MaterialSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'materials', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyMaterialDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single material delta into the accumulating outcome. Resolves the
 * business line, then upserts the material. Per-record failures are captured
 * (never thrown) so one bad record does not abort the batch — mirroring the
 * customer apply pattern.
 */
async function applyMaterialDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: MaterialDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const lini = await resolveLiniId(tx, companyId, record.lini_code)
    if (!lini.resolved) {
      outcome.failed++
      outcome.errors.push(materialError(index, record, 'LINI_NOT_FOUND', `Business line '${record.lini_code}' not found`))
      return
    }
    await upsertMaterialRecord(tx, companyId, lini.id, record, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(materialError(index, record, 'MATERIAL_UPSERT_CONFLICT', `Concurrent upsert conflict for '${record.erp_material_code}'`))
      return
    }
    outcome.failed++
    outcome.errors.push(materialError(index, record, 'MATERIAL_UPSERT_FAILED', `Failed to upsert material '${record.erp_material_code}'`))
  }
}

/**
 * Resolves a non-deleted business line id by tenant + ERP code. Because
 * `lini_code` is optional and the column is nullable, we distinguish three
 * cases: omitted → resolved with id=null (allowed), found → id set, and
 * provided-but-missing → unresolved so the caller can record LINI_NOT_FOUND.
 */
async function resolveLiniId(
  tx: Transaction,
  companyId: string,
  liniCode: string | null | undefined
): Promise<{ resolved: boolean; id: string | null }> {
  if (liniCode == null) return { resolved: true, id: null }
  const [row] = await tx
    .select({ id: masterLini.id })
    .from(masterLini)
    .where(
      and(
        eq(masterLini.companyId, companyId),
        eq(masterLini.code, liniCode),
        eq(masterLini.isDeleted, false)
      )
    )
  return row ? { resolved: true, id: row.id } : { resolved: false, id: null }
}

/** Inserts or updates a master_material row matched by (company_id, erp_material_code). */
async function upsertMaterialRecord(
  tx: Transaction,
  companyId: string,
  liniId: string | null,
  record: MaterialDelta,
  outcome: ApplyOutcome
): Promise<void> {
  const [existing] = await tx
    .select({ id: masterMaterial.id })
    .from(masterMaterial)
    .where(
      and(
        eq(masterMaterial.companyId, companyId),
        eq(masterMaterial.erpMaterialCode, record.erp_material_code)
      )
    )

  if (existing) {
    await updateMaterialRow(tx, existing.id, liniId, record)
    outcome.updated++
    return
  }
  await insertMaterialRow(tx, companyId, liniId, record)
  outcome.created++
}

/** Inserts a new master_material row. */
async function insertMaterialRow(
  tx: Transaction,
  companyId: string,
  liniId: string | null,
  record: MaterialDelta
): Promise<void> {
  await tx.insert(masterMaterial).values({
    companyId,
    erpMaterialCode: record.erp_material_code,
    name: record.name,
    baseUom: record.base_uom,
    salesUom: record.sales_uom,
    nie: record.nie ?? null,
    validNie: record.valid_nie ?? null,
    liniId,
    manufacture: record.manufacture ?? null,
    principal: record.principal ?? null,
    uomConversionRules: record.uom_conversion_rules,
    isNarcoticPsychotropic: record.is_narcotic_psychotropic ?? false,
    isActive: record.is_active ?? true,
  })
}

/** Updates the mutable fields of an existing master_material row (present fields only). */
async function updateMaterialRow(
  tx: Transaction,
  materialId: string,
  liniId: string | null,
  record: MaterialDelta
): Promise<void> {
  const values: Record<string, unknown> = {
    name: record.name,
    baseUom: record.base_uom,
    salesUom: record.sales_uom,
    liniId,
    uomConversionRules: record.uom_conversion_rules,
    updatedAt: sql`NOW()`,
  }
  if (record.nie !== undefined) values.nie = record.nie
  if (record.valid_nie !== undefined) values.validNie = record.valid_nie
  if (record.manufacture !== undefined) values.manufacture = record.manufacture
  if (record.principal !== undefined) values.principal = record.principal
  if (record.is_narcotic_psychotropic !== undefined) values.isNarcoticPsychotropic = record.is_narcotic_psychotropic
  if (record.is_active !== undefined) values.isActive = record.is_active

  await tx.update(masterMaterial).set(values).where(eq(masterMaterial.id, materialId))
}

/** Builds a structured per-record sync error entry keyed by the ERP material code. */
function materialError(
  index: number,
  record: MaterialDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: record.erp_material_code, code, message }
}

/** Inbound price list sync — upsert master_price (with varian & per). */
export async function syncPrices(
  tx: Transaction,
  companyId: string,
  input: PriceSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'prices', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyPriceDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single price delta into the accumulating outcome. Resolves the sales
 * office, material, and (optional) variant, then upserts the master_price row.
 * Per-record failures are captured (never thrown) so one bad record does not
 * abort the batch — mirroring the customer/material apply pattern.
 */
async function applyPriceDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: PriceDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const sofficeId = await resolveSofficeId(tx, companyId, record.soffice_code)
    if (!sofficeId) {
      outcome.failed++
      outcome.errors.push(priceError(index, record, 'SOFFICE_NOT_FOUND', `Sales office '${record.soffice_code}' not found`))
      return
    }
    const materialId = await resolveMaterialId(tx, companyId, record.erp_material_code)
    if (!materialId) {
      outcome.failed++
      outcome.errors.push(priceError(index, record, 'MATERIAL_NOT_FOUND', `Material '${record.erp_material_code}' not found`))
      return
    }
    const varian = await resolveVarianId(tx, companyId, record.varian_code)
    if (!varian.resolved) {
      outcome.failed++
      outcome.errors.push(priceError(index, record, 'VARIAN_NOT_FOUND', `Variant '${record.varian_code}' not found`))
      return
    }
    await upsertPriceRecord(tx, companyId, sofficeId, materialId, varian.id, record, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(priceError(index, record, 'PRICE_UPSERT_CONFLICT', `Concurrent upsert conflict for '${record.erp_material_code}'`))
      return
    }
    outcome.failed++
    outcome.errors.push(priceError(index, record, 'PRICE_UPSERT_FAILED', `Failed to upsert price for '${record.erp_material_code}'`))
  }
}

/** Resolves a non-deleted material id by tenant + ERP code. Returns null when absent. */
async function resolveMaterialId(
  tx: Transaction,
  companyId: string,
  erpMaterialCode: string
): Promise<string | null> {
  const [row] = await tx
    .select({ id: masterMaterial.id })
    .from(masterMaterial)
    .where(
      and(
        eq(masterMaterial.companyId, companyId),
        eq(masterMaterial.erpMaterialCode, erpMaterialCode),
        eq(masterMaterial.isDeleted, false)
      )
    )
  return row?.id ?? null
}

/**
 * Resolves a non-deleted variant id by tenant + code. Because `varian_code` is
 * optional and the column is nullable, we distinguish three cases: omitted/null
 * → resolved with id=null (default variant, allowed), found → id set, and
 * provided-but-missing → unresolved so the caller can record VARIAN_NOT_FOUND.
 */
async function resolveVarianId(
  tx: Transaction,
  companyId: string,
  varianCode: string | null | undefined
): Promise<{ resolved: boolean; id: string | null }> {
  if (varianCode == null) return { resolved: true, id: null }
  const [row] = await tx
    .select({ id: masterVarian.id })
    .from(masterVarian)
    .where(
      and(
        eq(masterVarian.companyId, companyId),
        eq(masterVarian.code, varianCode),
        eq(masterVarian.isDeleted, false)
      )
    )
  return row ? { resolved: true, id: row.id } : { resolved: false, id: null }
}

/**
 * Inserts or updates a master_price row matched by the unique key
 * (company_id, soffice_id, material_id, varian_id, valid_from). Because
 * `varian_id` is nullable and SQL `=` never matches NULL, the existing-row
 * lookup uses `isNull` for the default-variant case so those prices upsert.
 */
async function upsertPriceRecord(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  materialId: string,
  varianId: string | null,
  record: PriceDelta,
  outcome: ApplyOutcome
): Promise<void> {
  const [existing] = await tx
    .select({ id: masterPrice.id })
    .from(masterPrice)
    .where(
      and(
        eq(masterPrice.companyId, companyId),
        eq(masterPrice.sofficeId, sofficeId),
        eq(masterPrice.materialId, materialId),
        varianId === null ? isNull(masterPrice.varianId) : eq(masterPrice.varianId, varianId),
        eq(masterPrice.validFrom, record.valid_from)
      )
    )

  if (existing) {
    await updatePriceRow(tx, existing.id, record)
    outcome.updated++
    return
  }
  await insertPriceRow(tx, companyId, sofficeId, materialId, varianId, record)
  outcome.created++
}

/** Inserts a new master_price row. */
async function insertPriceRow(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  materialId: string,
  varianId: string | null,
  record: PriceDelta
): Promise<void> {
  await tx.insert(masterPrice).values({
    companyId,
    sofficeId,
    materialId,
    varianId,
    priceRegular: record.price_regular.toString(),
    priceHja: record.price_hja?.toString() ?? null,
    priceHet: record.price_het?.toString() ?? null,
    per: record.per ?? 1,
    salesUom: record.sales_uom,
    validFrom: record.valid_from,
    validTo: record.valid_to,
  })
}

/** Updates the mutable fields of an existing master_price row. */
async function updatePriceRow(
  tx: Transaction,
  priceId: string,
  record: PriceDelta
): Promise<void> {
  await tx
    .update(masterPrice)
    .set({
      priceRegular: record.price_regular.toString(),
      priceHja: record.price_hja?.toString() ?? null,
      priceHet: record.price_het?.toString() ?? null,
      per: record.per ?? 1,
      salesUom: record.sales_uom,
      validTo: record.valid_to,
    })
    .where(eq(masterPrice.id, priceId))
}

/**
 * Builds a structured per-record sync error entry. PriceDelta has no single
 * business key, so we compose one from soffice + material codes for traceability.
 */
function priceError(
  index: number,
  record: PriceDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: `${record.soffice_code}/${record.erp_material_code}`, code, message }
}

/** Inbound ATP stock sync — upsert stock_inventory_atp (with batch & SLED). */
export async function syncStock(
  tx: Transaction,
  companyId: string,
  input: StockSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'stock', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyStockDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single ATP stock delta into the accumulating outcome. Resolves the
 * sales office, material, and (optional) variant, then upserts the
 * stock_inventory_atp row keyed by batch. Per-record failures are captured
 * (never thrown) so one bad record does not abort the batch — mirroring the
 * price apply pattern.
 */
async function applyStockDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: StockDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const sofficeId = await resolveSofficeId(tx, companyId, record.soffice_code)
    if (!sofficeId) {
      outcome.failed++
      outcome.errors.push(stockError(index, record, 'SOFFICE_NOT_FOUND', `Sales office '${record.soffice_code}' not found`))
      return
    }
    const materialId = await resolveMaterialId(tx, companyId, record.erp_material_code)
    if (!materialId) {
      outcome.failed++
      outcome.errors.push(stockError(index, record, 'MATERIAL_NOT_FOUND', `Material '${record.erp_material_code}' not found`))
      return
    }
    const varian = await resolveVarianId(tx, companyId, record.varian_code)
    if (!varian.resolved) {
      outcome.failed++
      outcome.errors.push(stockError(index, record, 'VARIAN_NOT_FOUND', `Variant '${record.varian_code}' not found`))
      return
    }
    await upsertStockRecord(tx, companyId, sofficeId, materialId, varian.id, record, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(stockError(index, record, 'STOCK_UPSERT_CONFLICT', `Concurrent upsert conflict for '${record.erp_material_code}'`))
      return
    }
    outcome.failed++
    outcome.errors.push(stockError(index, record, 'STOCK_UPSERT_FAILED', `Failed to upsert stock for '${record.erp_material_code}'`))
  }
}

/**
 * Inserts or updates a stock_inventory_atp row matched by the unique key
 * (company_id, soffice_id, material_id, varian_id, batch). Because `varian_id`
 * is nullable and SQL `=` never matches NULL, the existing-row lookup uses
 * `isNull` for the default-variant case so those stock rows upsert.
 */
async function upsertStockRecord(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  materialId: string,
  varianId: string | null,
  record: StockDelta,
  outcome: ApplyOutcome
): Promise<void> {
  const [existing] = await tx
    .select({ id: stockInventoryAtp.id })
    .from(stockInventoryAtp)
    .where(
      and(
        eq(stockInventoryAtp.companyId, companyId),
        eq(stockInventoryAtp.sofficeId, sofficeId),
        eq(stockInventoryAtp.materialId, materialId),
        varianId === null ? isNull(stockInventoryAtp.varianId) : eq(stockInventoryAtp.varianId, varianId),
        eq(stockInventoryAtp.batch, record.batch)
      )
    )

  if (existing) {
    await updateStockRow(tx, existing.id, record)
    outcome.updated++
    return
  }
  await insertStockRow(tx, companyId, sofficeId, materialId, varianId, record)
  outcome.created++
}

/** Inserts a new stock_inventory_atp row. */
async function insertStockRow(
  tx: Transaction,
  companyId: string,
  sofficeId: string,
  materialId: string,
  varianId: string | null,
  record: StockDelta
): Promise<void> {
  await tx.insert(stockInventoryAtp).values({
    companyId,
    sofficeId,
    materialId,
    varianId,
    batch: record.batch,
    sled: record.sled ?? null,
    qtyAvailable: record.qty_available.toString(),
    qtyAllocated: (record.qty_allocated ?? 0).toString(),
    stockValue: record.stock_value?.toString() ?? '0',
    uom: record.uom,
    lastSyncedAt: sql`NOW()`,
  })
}

/** Updates the mutable fields of an existing stock_inventory_atp row. */
async function updateStockRow(
  tx: Transaction,
  stockId: string,
  record: StockDelta
): Promise<void> {
  await tx
    .update(stockInventoryAtp)
    .set({
      sled: record.sled ?? null,
      qtyAvailable: record.qty_available.toString(),
      qtyAllocated: (record.qty_allocated ?? 0).toString(),
      stockValue: record.stock_value?.toString() ?? '0',
      uom: record.uom,
      lastSyncedAt: sql`NOW()`,
    })
    .where(eq(stockInventoryAtp.id, stockId))
}

/**
 * Builds a structured per-record sync error entry. StockDelta has no single
 * business key, so we compose one from soffice + material + batch for traceability.
 */
function stockError(
  index: number,
  record: StockDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: `${record.soffice_code}/${record.erp_material_code}/${record.batch}`, code, message }
}

/** Inbound promotion sync — upsert master_promotions (with UOM refs). */
export async function syncPromotions(
  tx: Transaction,
  companyId: string,
  input: PromotionSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'promotions', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyPromotionDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single promotion delta into the accumulating outcome. Resolves the
 * optional free-goods material, then upserts the master_promotions row keyed by
 * promo_code. Per-record failures are captured (never thrown) so one bad record
 * does not abort the batch — mirroring the material/price apply pattern.
 */
async function applyPromotionDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: PromotionDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const freeMaterial = await resolveFreeMaterialId(tx, companyId, record.free_material_code)
    if (!freeMaterial.resolved) {
      outcome.failed++
      outcome.errors.push(promotionError(index, record, 'FREE_MATERIAL_NOT_FOUND', `Free material '${record.free_material_code}' not found`))
      return
    }
    await upsertPromotionRecord(tx, companyId, freeMaterial.id, record, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(promotionError(index, record, 'PROMOTION_UPSERT_CONFLICT', `Concurrent upsert conflict for '${record.promo_code}'`))
      return
    }
    outcome.failed++
    outcome.errors.push(promotionError(index, record, 'PROMOTION_UPSERT_FAILED', `Failed to upsert promotion '${record.promo_code}'`))
  }
}

/**
 * Resolves a non-deleted free-goods material id by tenant + ERP code. Because
 * `free_material_code` is optional and the column is nullable, we distinguish
 * three cases: omitted/null → resolved with id=null (allowed), found → id set,
 * and provided-but-missing → unresolved so the caller records FREE_MATERIAL_NOT_FOUND.
 */
async function resolveFreeMaterialId(
  tx: Transaction,
  companyId: string,
  freeMaterialCode: string | null | undefined
): Promise<{ resolved: boolean; id: string | null }> {
  if (freeMaterialCode == null) return { resolved: true, id: null }
  const id = await resolveMaterialId(tx, companyId, freeMaterialCode)
  return id ? { resolved: true, id } : { resolved: false, id: null }
}

/** Inserts or updates a master_promotions row matched by (company_id, promo_code). */
async function upsertPromotionRecord(
  tx: Transaction,
  companyId: string,
  freeMaterialId: string | null,
  record: PromotionDelta,
  outcome: ApplyOutcome
): Promise<void> {
  const [existing] = await tx
    .select({ id: masterPromotions.id })
    .from(masterPromotions)
    .where(
      and(
        eq(masterPromotions.companyId, companyId),
        eq(masterPromotions.promoCode, record.promo_code)
      )
    )

  if (existing) {
    await updatePromotionRow(tx, existing.id, freeMaterialId, record)
    outcome.updated++
    return
  }
  await insertPromotionRow(tx, companyId, freeMaterialId, record)
  outcome.created++
}

/** Inserts a new master_promotions row. */
async function insertPromotionRow(
  tx: Transaction,
  companyId: string,
  freeMaterialId: string | null,
  record: PromotionDelta
): Promise<void> {
  await tx.insert(masterPromotions).values({
    companyId,
    promoCode: record.promo_code,
    promoName: record.promo_name,
    promoType: record.promo_type,
    discountPercentage: record.discount_percentage?.toString() ?? '0',
    discountAmount: record.discount_amount?.toString() ?? '0',
    minOrderQty: record.min_order_qty ?? 1,
    freeMaterialId,
    freeMaterialQty: record.free_material_qty ?? 0,
    validStart: record.valid_start,
    validEnd: record.valid_end,
    isActive: record.is_active ?? true,
  })
}

/** Updates the mutable fields of an existing master_promotions row. */
async function updatePromotionRow(
  tx: Transaction,
  promotionId: string,
  freeMaterialId: string | null,
  record: PromotionDelta
): Promise<void> {
  await tx
    .update(masterPromotions)
    .set({
      promoName: record.promo_name,
      promoType: record.promo_type,
      discountPercentage: record.discount_percentage?.toString() ?? '0',
      discountAmount: record.discount_amount?.toString() ?? '0',
      minOrderQty: record.min_order_qty ?? 1,
      freeMaterialId,
      freeMaterialQty: record.free_material_qty ?? 0,
      validStart: record.valid_start,
      validEnd: record.valid_end,
      isActive: record.is_active ?? true,
    })
    .where(eq(masterPromotions.id, promotionId))
}

/** Builds a structured per-record sync error entry keyed by the promo code. */
function promotionError(
  index: number,
  record: PromotionDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: record.promo_code, code, message }
}

/** Inbound leads sync — auto-create visit_plans (is_lead_from_erp = true). */
export async function syncLeads(
  tx: Transaction,
  companyId: string,
  input: LeadSyncInput
): Promise<ErpSyncResult> {
  return runSync(companyId, 'leads', input.idempotency_key, input.records.length, async () => {
    const outcome = emptyOutcome()
    for (let index = 0; index < input.records.length; index++) {
      await applyLeadDelta(tx, companyId, index, input.records[index]!, outcome)
    }
    return outcome
  })
}

/**
 * Applies a single lead delta into the accumulating outcome. Resolves the
 * assignee user (validating the field-force role), the target customer, and the
 * optional outlet context, then inserts a visit_plans row flagged as an ERP
 * lead. Per-record failures are captured (never thrown) so one bad record does
 * not abort the batch — mirroring the customer/material apply pattern.
 */
async function applyLeadDelta(
  tx: Transaction,
  companyId: string,
  index: number,
  record: LeadDelta,
  outcome: ApplyOutcome
): Promise<void> {
  try {
    const assignee = await resolveAssigneeUser(tx, companyId, record.assignee_user_code)
    if (!assignee) {
      outcome.failed++
      outcome.errors.push(leadError(index, record, 'USER_NOT_FOUND', `Assignee user '${record.assignee_user_code}' not found`))
      return
    }
    const roleError = validateAssigneeRole(index, record, assignee.roleLabel)
    if (roleError) {
      outcome.failed++
      outcome.errors.push(roleError)
      return
    }
    await resolveTargetsAndInsertLead(tx, companyId, index, record, assignee.id, outcome)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      outcome.failed++
      outcome.errors.push(leadError(index, record, 'LEAD_DUPLICATE', `Visit plan already exists for '${record.assignee_user_code}' on ${record.plan_date}`))
      return
    }
    outcome.failed++
    outcome.errors.push(leadError(index, record, 'LEAD_UPSERT_FAILED', `Failed to create lead visit plan for '${record.assignee_user_code}'`))
  }
}

/**
 * Resolves the target customer + optional outlet context, then inserts the
 * visit_plans lead row. Split from applyLeadDelta to keep each function focused
 * and under the 30-line steering limit.
 */
async function resolveTargetsAndInsertLead(
  tx: Transaction,
  companyId: string,
  index: number,
  record: LeadDelta,
  userId: string,
  outcome: ApplyOutcome
): Promise<void> {
  const customerId = await resolveCustomerId(tx, companyId, record.erp_customer_code)
  if (!customerId) {
    outcome.failed++
    outcome.errors.push(leadError(index, record, 'CUSTOMER_NOT_FOUND', `Customer '${record.erp_customer_code}' not found`))
    return
  }
  const outletContext = await resolveOutletContextId(tx, companyId, record.outlet_context_code)
  if (!outletContext.resolved) {
    outcome.failed++
    outcome.errors.push(leadError(index, record, 'OUTLET_CONTEXT_NOT_FOUND', `Outlet context '${record.outlet_context_code}' not found`))
    return
  }
  await insertLeadVisitPlan(tx, companyId, userId, customerId, outletContext.id, record)
  outcome.created++
}

/**
 * Resolves the assignee user id + role by tenant + business key. The app_users
 * schema has no dedicated ERP-code column, so `email` (the only unique business
 * identifier on the table) is used as the assignee business key. Returns null
 * when no active, non-deleted user matches.
 */
async function resolveAssigneeUser(
  tx: Transaction,
  companyId: string,
  assigneeUserCode: string
): Promise<{ id: string; roleLabel: string } | null> {
  const [row] = await tx
    .select({ id: appUsers.id, roleLabel: appUsers.roleLabel })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.companyId, companyId),
        eq(appUsers.email, assigneeUserCode),
        eq(appUsers.isActive, true),
        eq(appUsers.isDeleted, false)
      )
    )
  return row ?? null
}

/**
 * Validates that the resolved user holds a field-force role (SALESMAN/MR) and,
 * when the record specifies an expected role, that it matches. Returns a
 * structured error entry on failure, or null when the role is valid.
 */
function validateAssigneeRole(
  index: number,
  record: LeadDelta,
  roleLabel: string
): ApplyOutcome['errors'][number] | null {
  if (roleLabel !== 'SALESMAN' && roleLabel !== 'MR') {
    return leadError(index, record, 'USER_ROLE_INVALID', `User '${record.assignee_user_code}' is not a field-force role (got ${roleLabel})`)
  }
  if (record.assignee_role && record.assignee_role !== roleLabel) {
    return leadError(index, record, 'ROLE_MISMATCH', `Expected role ${record.assignee_role} but user '${record.assignee_user_code}' is ${roleLabel}`)
  }
  return null
}

/** Resolves a non-deleted customer id by tenant + ERP code. Returns null when absent. */
async function resolveCustomerId(
  tx: Transaction,
  companyId: string,
  erpCustomerCode: string
): Promise<string | null> {
  const [row] = await tx
    .select({ id: masterCustomer.id })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.companyId, companyId),
        eq(masterCustomer.erpCustomerCode, erpCustomerCode),
        eq(masterCustomer.isDeleted, false)
      )
    )
  return row?.id ?? null
}

/**
 * Resolves the optional outlet-context customer id by tenant + ERP code. Because
 * `outlet_context_code` is optional and nullable, we distinguish three cases:
 * omitted/null → resolved with id=null (allowed), found → id set, and
 * provided-but-missing → unresolved so the caller records OUTLET_CONTEXT_NOT_FOUND —
 * mirroring the resolveVarianId/resolveLiniId three-case pattern.
 */
async function resolveOutletContextId(
  tx: Transaction,
  companyId: string,
  outletContextCode: string | null | undefined
): Promise<{ resolved: boolean; id: string | null }> {
  if (outletContextCode == null) return { resolved: true, id: null }
  const id = await resolveCustomerId(tx, companyId, outletContextCode)
  return id ? { resolved: true, id } : { resolved: false, id: null }
}

/**
 * Inserts a visit_plans lead row. A duplicate against uq_user_plan_target
 * (company_id, user_id, customer_id, outlet_context_id, plan_date) surfaces as a
 * unique violation that applyLeadDelta maps to a non-fatal LEAD_DUPLICATE error.
 */
async function insertLeadVisitPlan(
  tx: Transaction,
  companyId: string,
  userId: string,
  customerId: string,
  outletContextId: string | null,
  record: LeadDelta
): Promise<void> {
  await tx.insert(visitPlans).values({
    companyId,
    userId,
    customerId,
    outletContextId,
    planDate: record.plan_date,
    isLeadFromErp: true,
    isApproved: true,
  })
}

/** Builds a structured per-record sync error entry keyed by the assignee user code. */
function leadError(
  index: number,
  record: LeadDelta,
  code: string,
  message: string
): ApplyOutcome['errors'][number] {
  return { index, business_key: record.assignee_user_code, code, message }
}
