import { describe, it, expect, beforeEach, mock } from 'bun:test'

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440002'
const CUSTOMER_ID = '990e8400-e29b-41d4-a716-446655440009'
const DOCTOR_PROFILE_ID = 'bb0e8400-e29b-41d4-a716-44665544000b'

// Redis idempotency claim result is configurable: 'OK' = first delivery (apply
// runs), null = duplicate delivery (apply short-circuits). Defaults to 'OK'.
const redisClaim: { result: 'OK' | null } = { result: 'OK' }

mock.module('../../../config/redis', () => ({
  redis: { set: () => Promise.resolve(redisClaim.result) },
}))

const { syncCustomers, syncMaterials, syncPrices, syncStock, syncPromotions, syncLeads } = await import('../service')

// -----------------------------------------------------------------------------
// Fake Drizzle transaction
//
// The service issues, in order per record:
//   1. select soffice id      → sofficeRows
//   2. select existing customer → existingCustomerRows
//   3. insert customer (returning id)  [only when no existing customer]
//   4. select existing doctor profile  [DOCTOR only]
//   5. insert/update doctor profile     [DOCTOR only]
//
// The fake records calls and returns queued results per operation so each test
// can shape the DB response without a real database.
// -----------------------------------------------------------------------------

interface FakeState {
  sofficeRows: Array<{ id: string }>
  existingCustomerRows: Array<{ id: string }>
  existingDoctorRows: Array<{ id: string }>
  insertReturnId: string
  insertCalls: number
  updateCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let state: FakeState

function resetState(): void {
  state = {
    sofficeRows: [{ id: SOFFICE_ID }],
    existingCustomerRows: [],
    existingDoctorRows: [],
    insertReturnId: CUSTOMER_ID,
    insertCalls: 0,
    updateCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable that mimics Drizzle's query builder. Each terminal
 * `.where()` / `.returning()` resolves to the queued rows for that operation.
 */
function makeTx(): unknown {
  const resolveSelect = (): Array<{ id: string }> => {
    // select order: soffice → customer → doctor profile
    const n = state.selectCount++
    if (n === 0) return state.sofficeRows
    if (n === 1) return state.existingCustomerRows
    return state.existingDoctorRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        state.insertCalls++
        if (state.throwOnInsert) return { returning: () => Promise.reject(state.throwOnInsert) }
        return {
          returning: () => Promise.resolve([{ id: state.insertReturnId }]),
          then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          state.updateCalls++
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
}

function customerInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: 'aa0e8400-e29b-41d4-a716-44665544000a',
    records: [
      {
        erp_customer_code: 'CUST-001',
        soffice_code: 'SO-01',
        customer_type: 'OUTLET',
        name: 'Apotek Sehat',
        ...overrides,
      },
    ],
  }
}

describe('syncCustomers — inbound delta upsert', () => {
  beforeEach(() => {
    resetState()
  })

  it('inserts a new customer → created=1', async () => {
    state.existingCustomerRows = []
    const res = await syncCustomers(makeTx() as never, COMPANY_ID, customerInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.updated).toBe(0)
    expect(res.data.failed).toBe(0)
    expect(state.insertCalls).toBe(1)
  })

  it('updates an existing customer → updated=1', async () => {
    state.existingCustomerRows = [{ id: CUSTOMER_ID }]
    const res = await syncCustomers(makeTx() as never, COMPANY_ID, customerInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(state.updateCalls).toBe(1)
    expect(state.insertCalls).toBe(0)
  })

  it('records SOFFICE_NOT_FOUND failure without aborting', async () => {
    state.sofficeRows = []
    const res = await syncCustomers(makeTx() as never, COMPANY_ID, customerInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'CUST-001',
      code: 'SOFFICE_NOT_FOUND',
    })
  })

  it('upserts a doctor profile when customer_type=DOCTOR (insert path)', async () => {
    state.existingCustomerRows = []
    state.existingDoctorRows = []
    const res = await syncCustomers(
      makeTx() as never,
      COMPANY_ID,
      customerInput({
        customer_type: 'DOCTOR',
        doctor_profile: { specialization: 'Cardiology', sip_str_number: 'SIP-123' },
      }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    // customer insert + doctor profile insert
    expect(state.insertCalls).toBe(2)
  })

  it('updates an existing doctor profile on update path', async () => {
    state.existingCustomerRows = [{ id: CUSTOMER_ID }]
    state.existingDoctorRows = [{ id: DOCTOR_PROFILE_ID }]
    const res = await syncCustomers(
      makeTx() as never,
      COMPANY_ID,
      customerInput({
        customer_type: 'DOCTOR',
        doctor_profile: { specialization: 'Neurology' },
      }) as never
    )
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    // customer update + doctor profile update
    expect(state.updateCalls).toBe(2)
  })

  it('captures a unique-violation race as a per-record failure', async () => {
    state.existingCustomerRows = []
    const uniqueErr = Object.assign(new Error('dup'), { code: '23505' })
    state.throwOnInsert = uniqueErr
    const res = await syncCustomers(makeTx() as never, COMPANY_ID, customerInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'CUSTOMER_UPSERT_CONFLICT' })
  })

  it('captures an unexpected DB error as CUSTOMER_UPSERT_FAILED', async () => {
    state.existingCustomerRows = []
    state.throwOnInsert = new Error('connection lost')
    const res = await syncCustomers(makeTx() as never, COMPANY_ID, customerInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'CUSTOMER_UPSERT_FAILED' })
  })
})

const LINI_ID = 'cc0e8400-e29b-41d4-a716-44665544000c'
const MATERIAL_ID = 'dd0e8400-e29b-41d4-a716-44665544000d'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction for material sync
//
// Per record the service issues, in order:
//   1. select lini id       → liniRows   (ONLY when lini_code is provided)
//   2. select existing material → existingMaterialRows
//   3. insert material        [only when no existing material]
//   4. update material        [only when existing material]
// -----------------------------------------------------------------------------

interface MaterialFakeState {
  liniRows: Array<{ id: string }>
  existingMaterialRows: Array<{ id: string }>
  skipLiniSelect: boolean
  insertCalls: number
  updateCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let mstate: MaterialFakeState

function resetMaterialState(): void {
  mstate = {
    liniRows: [{ id: LINI_ID }],
    existingMaterialRows: [],
    skipLiniSelect: false,
    insertCalls: 0,
    updateCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable mimicking Drizzle. When `skipLiniSelect` is true
 * (lini_code omitted) the first select is the material lookup, since the service
 * does not query master_lini for a null code.
 */
function makeMaterialTx(): unknown {
  const resolveSelect = (): Array<{ id: string }> => {
    const n = mstate.selectCount++
    if (mstate.skipLiniSelect) return mstate.existingMaterialRows
    return n === 0 ? mstate.liniRows : mstate.existingMaterialRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        mstate.insertCalls++
        if (mstate.throwOnInsert) return Promise.reject(mstate.throwOnInsert)
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          mstate.updateCalls++
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
}

function materialInput(
  overrides: Record<string, unknown> = {},
  extraRecords: Array<Record<string, unknown>> = []
) {
  return {
    idempotency_key: 'ee0e8400-e29b-41d4-a716-44665544000e',
    records: [
      {
        erp_material_code: 'MAT-001',
        name: 'Paracetamol 500mg',
        base_uom: 'PCS',
        sales_uom: 'BOX',
        lini_code: 'FARMA_ETHICAL',
        uom_conversion_rules: { BOX: 100, STRIP: 10 },
        ...overrides,
      },
      ...extraRecords,
    ],
  }
}

describe('syncMaterials — inbound delta upsert', () => {
  beforeEach(() => {
    resetMaterialState()
    redisClaim.result = 'OK'
  })

  it('inserts a new material → created=1', async () => {
    mstate.existingMaterialRows = []
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.updated).toBe(0)
    expect(res.data.failed).toBe(0)
    expect(mstate.insertCalls).toBe(1)
  })

  it('updates an existing material → updated=1', async () => {
    mstate.existingMaterialRows = [{ id: MATERIAL_ID }]
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(mstate.updateCalls).toBe(1)
    expect(mstate.insertCalls).toBe(0)
  })

  it('allows a null lini_code → liniId null, still inserts', async () => {
    mstate.skipLiniSelect = true
    mstate.existingMaterialRows = []
    const res = await syncMaterials(
      makeMaterialTx() as never,
      COMPANY_ID,
      materialInput({ lini_code: null }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(mstate.insertCalls).toBe(1)
  })

  it('records LINI_NOT_FOUND failure without aborting or inserting', async () => {
    mstate.liniRows = []
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.failed).toBe(1)
    expect(mstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'MAT-001',
      code: 'LINI_NOT_FOUND',
    })
  })

  it('captures a unique-violation race as MATERIAL_UPSERT_CONFLICT', async () => {
    mstate.existingMaterialRows = []
    mstate.throwOnInsert = Object.assign(new Error('dup'), { code: '23505' })
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'MATERIAL_UPSERT_CONFLICT' })
  })

  it('captures an unexpected DB error as MATERIAL_UPSERT_FAILED', async () => {
    mstate.existingMaterialRows = []
    mstate.throwOnInsert = new Error('connection lost')
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'MATERIAL_UPSERT_FAILED' })
  })

  it('short-circuits duplicate idempotency_key without applying', async () => {
    redisClaim.result = null
    const res = await syncMaterials(makeMaterialTx() as never, COMPANY_ID, materialInput() as never)
    expect(res.data.duplicate).toBe(true)
    expect(res.data.received).toBe(1)
    expect(res.data.created).toBe(0)
    expect(mstate.insertCalls).toBe(0)
  })

  it('reports partial success in a mixed batch (one bad record)', async () => {
    // Record 0: lini found → insert. Record 1: lini missing → LINI_NOT_FOUND.
    mstate.existingMaterialRows = []
    const secondRecord = {
      erp_material_code: 'MAT-002',
      name: 'Amoxicillin 500mg',
      base_uom: 'PCS',
      sales_uom: 'BOX',
      lini_code: 'MISSING_LINI',
      uom_conversion_rules: { BOX: 50 },
    }
    // First record: lini lookup found; second record: lini lookup empty.
    let liniLookups = 0
    const tx = {
      select: () => ({
        from: () => ({
          where: (): Promise<Array<{ id: string }>> => {
            liniLookups++
            // seq per record: lini, material. Record1 lini(found)=1, material=2,
            // Record2 lini(empty)=3
            if (liniLookups === 1) return Promise.resolve([{ id: LINI_ID }])
            if (liniLookups === 2) return Promise.resolve([])
            return Promise.resolve([])
          },
        }),
      }),
      insert: () => ({ values: () => { mstate.insertCalls++; return Promise.resolve(undefined) } }),
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    }
    const res = await syncMaterials(tx as never, COMPANY_ID, materialInput({}, [secondRecord]) as never)
    expect(res.data.received).toBe(2)
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ index: 1, business_key: 'MAT-002', code: 'LINI_NOT_FOUND' })
  })
})

const VARIAN_ID = 'ff0e8400-e29b-41d4-a716-44665544000f'
const PRICE_ID = '110e8400-e29b-41d4-a716-446655440011'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction for price sync
//
// Per record the service issues selects in order:
//   1. select soffice id        → sofficeRows
//   2. select material id        → materialRows
//   3. select varian id          → varianRows   (ONLY when varian_code provided)
//   4. select existing price      → existingPriceRows
// followed by insert (new) or update (existing).
// `skipVarianSelect` mirrors the service skipping the varian lookup for a
// null/omitted varian_code (default variant path).
// -----------------------------------------------------------------------------

interface PriceFakeState {
  sofficeRows: Array<{ id: string }>
  materialRows: Array<{ id: string }>
  varianRows: Array<{ id: string }>
  existingPriceRows: Array<{ id: string }>
  skipVarianSelect: boolean
  insertCalls: number
  updateCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let pstate: PriceFakeState

function resetPriceState(): void {
  pstate = {
    sofficeRows: [{ id: SOFFICE_ID }],
    materialRows: [{ id: MATERIAL_ID }],
    varianRows: [{ id: VARIAN_ID }],
    existingPriceRows: [],
    skipVarianSelect: false,
    insertCalls: 0,
    updateCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable mimicking Drizzle. When `skipVarianSelect` is true
 * (varian_code omitted/null) the varian lookup is skipped, so the select order
 * collapses to soffice → material → existing price.
 */
function makePriceTx(): unknown {
  const resolveSelect = (): Array<{ id: string }> => {
    const n = pstate.selectCount++
    if (pstate.skipVarianSelect) {
      if (n === 0) return pstate.sofficeRows
      if (n === 1) return pstate.materialRows
      return pstate.existingPriceRows
    }
    if (n === 0) return pstate.sofficeRows
    if (n === 1) return pstate.materialRows
    if (n === 2) return pstate.varianRows
    return pstate.existingPriceRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        pstate.insertCalls++
        if (pstate.throwOnInsert) return Promise.reject(pstate.throwOnInsert)
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          pstate.updateCalls++
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
}

function priceInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: '220e8400-e29b-41d4-a716-446655440022',
    records: [
      {
        soffice_code: 'SO-01',
        erp_material_code: 'MAT-001',
        varian_code: 'REGULAR',
        price_regular: 15000,
        sales_uom: 'BOX',
        valid_from: '2024-01-01',
        valid_to: '2024-12-31',
        ...overrides,
      },
    ],
  }
}

describe('syncPrices — inbound delta upsert', () => {
  beforeEach(() => {
    resetPriceState()
    redisClaim.result = 'OK'
  })

  it('inserts a new price → created=1', async () => {
    pstate.existingPriceRows = []
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.updated).toBe(0)
    expect(res.data.failed).toBe(0)
    expect(pstate.insertCalls).toBe(1)
  })

  it('updates an existing price → updated=1', async () => {
    pstate.existingPriceRows = [{ id: PRICE_ID }]
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(pstate.updateCalls).toBe(1)
    expect(pstate.insertCalls).toBe(0)
  })

  it('records SOFFICE_NOT_FOUND failure without aborting or inserting', async () => {
    pstate.sofficeRows = []
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.failed).toBe(1)
    expect(pstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'SO-01/MAT-001',
      code: 'SOFFICE_NOT_FOUND',
    })
  })

  it('records MATERIAL_NOT_FOUND failure without aborting or inserting', async () => {
    pstate.materialRows = []
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.failed).toBe(1)
    expect(pstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'SO-01/MAT-001',
      code: 'MATERIAL_NOT_FOUND',
    })
  })

  it('records VARIAN_NOT_FOUND when a provided variant code is missing', async () => {
    pstate.varianRows = []
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.failed).toBe(1)
    expect(pstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'VARIAN_NOT_FOUND' })
  })

  it('allows a null varian_code → default variant, still inserts', async () => {
    pstate.skipVarianSelect = true
    pstate.existingPriceRows = []
    const res = await syncPrices(
      makePriceTx() as never,
      COMPANY_ID,
      priceInput({ varian_code: null }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(pstate.insertCalls).toBe(1)
  })

  it('captures a unique-violation race as PRICE_UPSERT_CONFLICT', async () => {
    pstate.existingPriceRows = []
    pstate.throwOnInsert = Object.assign(new Error('dup'), { code: '23505' })
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'PRICE_UPSERT_CONFLICT' })
  })

  it('captures an unexpected DB error as PRICE_UPSERT_FAILED', async () => {
    pstate.existingPriceRows = []
    pstate.throwOnInsert = new Error('connection lost')
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'PRICE_UPSERT_FAILED' })
  })

  it('short-circuits duplicate idempotency_key without applying', async () => {
    redisClaim.result = null
    const res = await syncPrices(makePriceTx() as never, COMPANY_ID, priceInput() as never)
    expect(res.data.duplicate).toBe(true)
    expect(res.data.received).toBe(1)
    expect(res.data.created).toBe(0)
    expect(pstate.insertCalls).toBe(0)
  })
})

const STOCK_ID = '330e8400-e29b-41d4-a716-446655440033'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction for stock ATP sync
//
// Per record the service issues selects in order:
//   1. select soffice id        → sofficeRows
//   2. select material id        → materialRows
//   3. select varian id          → varianRows   (ONLY when varian_code provided)
//   4. select existing stock      → existingStockRows
// followed by insert (new) or update (existing).
// `skipVarianSelect` mirrors the service skipping the varian lookup for a
// null/omitted varian_code (default variant path).
// -----------------------------------------------------------------------------

interface StockFakeState {
  sofficeRows: Array<{ id: string }>
  materialRows: Array<{ id: string }>
  varianRows: Array<{ id: string }>
  existingStockRows: Array<{ id: string }>
  skipVarianSelect: boolean
  insertCalls: number
  updateCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let sstate: StockFakeState

function resetStockState(): void {
  sstate = {
    sofficeRows: [{ id: SOFFICE_ID }],
    materialRows: [{ id: MATERIAL_ID }],
    varianRows: [{ id: VARIAN_ID }],
    existingStockRows: [],
    skipVarianSelect: false,
    insertCalls: 0,
    updateCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable mimicking Drizzle. When `skipVarianSelect` is true
 * (varian_code omitted/null) the varian lookup is skipped, so the select order
 * collapses to soffice → material → existing stock.
 */
function makeStockTx(): unknown {
  const resolveSelect = (): Array<{ id: string }> => {
    const n = sstate.selectCount++
    if (sstate.skipVarianSelect) {
      if (n === 0) return sstate.sofficeRows
      if (n === 1) return sstate.materialRows
      return sstate.existingStockRows
    }
    if (n === 0) return sstate.sofficeRows
    if (n === 1) return sstate.materialRows
    if (n === 2) return sstate.varianRows
    return sstate.existingStockRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        sstate.insertCalls++
        if (sstate.throwOnInsert) return Promise.reject(sstate.throwOnInsert)
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          sstate.updateCalls++
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
}

function stockInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: '440e8400-e29b-41d4-a716-446655440044',
    records: [
      {
        soffice_code: 'SO-01',
        erp_material_code: 'MAT-001',
        varian_code: 'REGULAR',
        batch: 'BATCH-2024-A',
        sled: '2026-06-30',
        qty_available: 250,
        uom: 'BOX',
        ...overrides,
      },
    ],
  }
}

describe('syncStock — inbound ATP delta upsert', () => {
  beforeEach(() => {
    resetStockState()
    redisClaim.result = 'OK'
  })

  it('inserts a new stock row → created=1', async () => {
    sstate.existingStockRows = []
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.updated).toBe(0)
    expect(res.data.failed).toBe(0)
    expect(sstate.insertCalls).toBe(1)
  })

  it('updates an existing stock row (same batch) → updated=1', async () => {
    sstate.existingStockRows = [{ id: STOCK_ID }]
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(sstate.updateCalls).toBe(1)
    expect(sstate.insertCalls).toBe(0)
  })

  it('records SOFFICE_NOT_FOUND failure without aborting or inserting', async () => {
    sstate.sofficeRows = []
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.failed).toBe(1)
    expect(sstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'SO-01/MAT-001/BATCH-2024-A',
      code: 'SOFFICE_NOT_FOUND',
    })
  })

  it('records MATERIAL_NOT_FOUND failure without aborting or inserting', async () => {
    sstate.materialRows = []
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.failed).toBe(1)
    expect(sstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'SO-01/MAT-001/BATCH-2024-A',
      code: 'MATERIAL_NOT_FOUND',
    })
  })

  it('records VARIAN_NOT_FOUND when a provided variant code is missing', async () => {
    sstate.varianRows = []
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.failed).toBe(1)
    expect(sstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'VARIAN_NOT_FOUND' })
  })

  it('allows a null varian_code → default variant, still inserts', async () => {
    sstate.skipVarianSelect = true
    sstate.existingStockRows = []
    const res = await syncStock(
      makeStockTx() as never,
      COMPANY_ID,
      stockInput({ varian_code: null }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(sstate.insertCalls).toBe(1)
  })

  it('captures a unique-violation race as STOCK_UPSERT_CONFLICT', async () => {
    sstate.existingStockRows = []
    sstate.throwOnInsert = Object.assign(new Error('dup'), { code: '23505' })
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'STOCK_UPSERT_CONFLICT' })
  })

  it('captures an unexpected DB error as STOCK_UPSERT_FAILED', async () => {
    sstate.existingStockRows = []
    sstate.throwOnInsert = new Error('connection lost')
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'STOCK_UPSERT_FAILED' })
  })

  it('short-circuits duplicate idempotency_key without applying', async () => {
    redisClaim.result = null
    const res = await syncStock(makeStockTx() as never, COMPANY_ID, stockInput() as never)
    expect(res.data.duplicate).toBe(true)
    expect(res.data.received).toBe(1)
    expect(res.data.created).toBe(0)
    expect(sstate.insertCalls).toBe(0)
  })
})

const PROMO_ID = '550e8400-e29b-41d4-a716-446655440055'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction for promotion sync
//
// Per record the service issues selects in order:
//   1. select free material id → freeMaterialRows (ONLY when free_material_code provided)
//   2. select existing promotion → existingPromoRows
// followed by insert (new) or update (existing).
// `skipMaterialSelect` mirrors the service skipping the material lookup for a
// null/omitted free_material_code (no free goods).
// -----------------------------------------------------------------------------

interface PromoFakeState {
  freeMaterialRows: Array<{ id: string }>
  existingPromoRows: Array<{ id: string }>
  skipMaterialSelect: boolean
  insertCalls: number
  updateCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let prstate: PromoFakeState

function resetPromoState(): void {
  prstate = {
    freeMaterialRows: [{ id: MATERIAL_ID }],
    existingPromoRows: [],
    skipMaterialSelect: false,
    insertCalls: 0,
    updateCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable mimicking Drizzle. When `skipMaterialSelect` is
 * true (free_material_code omitted/null) the material lookup is skipped, so the
 * select order collapses to just the existing-promotion lookup.
 */
function makePromoTx(): unknown {
  const resolveSelect = (): Array<{ id: string }> => {
    const n = prstate.selectCount++
    if (prstate.skipMaterialSelect) return prstate.existingPromoRows
    return n === 0 ? prstate.freeMaterialRows : prstate.existingPromoRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        prstate.insertCalls++
        if (prstate.throwOnInsert) return Promise.reject(prstate.throwOnInsert)
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          prstate.updateCalls++
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
}

function promotionInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: '660e8400-e29b-41d4-a716-446655440066',
    records: [
      {
        promo_code: 'PROMO-001',
        promo_name: 'Buy 10 Get 1 Free',
        promo_type: 'FREE_GOODS',
        discount_percentage: 0,
        free_material_code: 'MAT-001',
        free_material_qty: 1,
        min_order_qty: 10,
        valid_start: '2024-01-01T00:00:00Z',
        valid_end: '2024-12-31T23:59:59Z',
        ...overrides,
      },
    ],
  }
}

describe('syncPromotions — inbound delta upsert', () => {
  beforeEach(() => {
    resetPromoState()
    redisClaim.result = 'OK'
  })

  it('inserts a new promotion → created=1', async () => {
    prstate.existingPromoRows = []
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.updated).toBe(0)
    expect(res.data.failed).toBe(0)
    expect(prstate.insertCalls).toBe(1)
  })

  it('updates an existing promotion → updated=1', async () => {
    prstate.existingPromoRows = [{ id: PROMO_ID }]
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.updated).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(prstate.updateCalls).toBe(1)
    expect(prstate.insertCalls).toBe(0)
  })

  it('allows a null free_material_code → freeMaterialId null, still inserts', async () => {
    prstate.skipMaterialSelect = true
    prstate.existingPromoRows = []
    const res = await syncPromotions(
      makePromoTx() as never,
      COMPANY_ID,
      promotionInput({ promo_type: 'PERCENT_DISCOUNT', free_material_code: null, discount_percentage: 15 }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(prstate.insertCalls).toBe(1)
  })

  it('records FREE_MATERIAL_NOT_FOUND when a provided material code is missing', async () => {
    prstate.freeMaterialRows = []
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.failed).toBe(1)
    expect(prstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'PROMO-001',
      code: 'FREE_MATERIAL_NOT_FOUND',
    })
  })

  it('captures a unique-violation race as PROMOTION_UPSERT_CONFLICT', async () => {
    prstate.existingPromoRows = []
    prstate.throwOnInsert = Object.assign(new Error('dup'), { code: '23505' })
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'PROMOTION_UPSERT_CONFLICT' })
  })

  it('captures an unexpected DB error as PROMOTION_UPSERT_FAILED', async () => {
    prstate.existingPromoRows = []
    prstate.throwOnInsert = new Error('connection lost')
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ code: 'PROMOTION_UPSERT_FAILED' })
  })

  it('short-circuits duplicate idempotency_key without applying', async () => {
    redisClaim.result = null
    const res = await syncPromotions(makePromoTx() as never, COMPANY_ID, promotionInput() as never)
    expect(res.data.duplicate).toBe(true)
    expect(res.data.received).toBe(1)
    expect(res.data.created).toBe(0)
    expect(prstate.insertCalls).toBe(0)
  })
})

const USER_ID = '770e8400-e29b-41d4-a716-446655440077'
const OUTLET_CONTEXT_ID = '880e8400-e29b-41d4-a716-446655440088'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction for leads sync
//
// Per record the service issues selects in order:
//   1. select assignee user (id + role_label) → userRows
//   2. select customer id                      → customerRows
//   3. select outlet context customer id       → outletRows (ONLY when outlet_context_code provided)
// followed by insert into visit_plans (created path).
// `skipOutletSelect` mirrors the service skipping the outlet lookup for a
// null/omitted outlet_context_code (no doctor outlet context).
// -----------------------------------------------------------------------------

interface LeadFakeState {
  userRows: Array<{ id: string; roleLabel: string }>
  customerRows: Array<{ id: string }>
  outletRows: Array<{ id: string }>
  skipOutletSelect: boolean
  insertCalls: number
  selectCount: number
  throwOnInsert?: Error
}

let lstate: LeadFakeState

function resetLeadState(): void {
  lstate = {
    userRows: [{ id: USER_ID, roleLabel: 'SALESMAN' }],
    customerRows: [{ id: CUSTOMER_ID }],
    outletRows: [{ id: OUTLET_CONTEXT_ID }],
    skipOutletSelect: true,
    insertCalls: 0,
    selectCount: 0,
  }
}

/**
 * Builds a chainable thenable mimicking Drizzle. The user lookup selects both
 * id and role_label, so the select resolver returns row shapes accordingly.
 * When `skipOutletSelect` is true (outlet_context_code omitted/null) the outlet
 * lookup is skipped, collapsing the order to user → customer.
 */
function makeLeadTx(): unknown {
  const resolveSelect = (): Array<{ id: string; roleLabel?: string }> => {
    const n = lstate.selectCount++
    if (n === 0) return lstate.userRows
    if (n === 1) return lstate.customerRows
    return lstate.outletRows
  }

  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string; roleLabel?: string }>> => Promise.resolve(resolveSelect()),
      }),
    }),
    insert: () => ({
      values: () => {
        lstate.insertCalls++
        if (lstate.throwOnInsert) return Promise.reject(lstate.throwOnInsert)
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }
}

function leadInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: '770e8400-e29b-41d4-a716-446655440099',
    records: [
      {
        assignee_user_code: 'salesman@kimiafarma.co.id',
        erp_customer_code: 'CUST-001',
        plan_date: '2024-06-01',
        ...overrides,
      },
    ],
  }
}

describe('syncLeads — inbound lead → visit_plans auto-create', () => {
  beforeEach(() => {
    resetLeadState()
    redisClaim.result = 'OK'
  })

  it('creates a visit plan for a valid salesman lead → created=1', async () => {
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(lstate.insertCalls).toBe(1)
  })

  it('creates a visit plan for a valid MR lead → created=1', async () => {
    lstate.userRows = [{ id: USER_ID, roleLabel: 'MR' }]
    const res = await syncLeads(
      makeLeadTx() as never,
      COMPANY_ID,
      leadInput({ assignee_role: 'MR', assignee_user_code: 'mr@kimiafarma.co.id' }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(lstate.insertCalls).toBe(1)
  })

  it('resolves an optional outlet context when provided → created=1', async () => {
    lstate.skipOutletSelect = false
    const res = await syncLeads(
      makeLeadTx() as never,
      COMPANY_ID,
      leadInput({ outlet_context_code: 'CUST-OUTLET-01' }) as never
    )
    expect(res.data.created).toBe(1)
    expect(res.data.failed).toBe(0)
    expect(lstate.insertCalls).toBe(1)
  })

  it('records USER_NOT_FOUND when the assignee cannot be resolved', async () => {
    lstate.userRows = []
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.failed).toBe(1)
    expect(lstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({
      index: 0,
      business_key: 'salesman@kimiafarma.co.id',
      code: 'USER_NOT_FOUND',
    })
  })

  it('records USER_ROLE_INVALID when the user is not a field-force role', async () => {
    lstate.userRows = [{ id: USER_ID, roleLabel: 'ADMIN_CABANG' }]
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.failed).toBe(1)
    expect(lstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'USER_ROLE_INVALID' })
  })

  it('records ROLE_MISMATCH when the expected role differs from the resolved role', async () => {
    lstate.userRows = [{ id: USER_ID, roleLabel: 'SALESMAN' }]
    const res = await syncLeads(
      makeLeadTx() as never,
      COMPANY_ID,
      leadInput({ assignee_role: 'MR' }) as never
    )
    expect(res.data.failed).toBe(1)
    expect(lstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'ROLE_MISMATCH' })
  })

  it('records CUSTOMER_NOT_FOUND when the target customer is missing', async () => {
    lstate.customerRows = []
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.failed).toBe(1)
    expect(lstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'CUSTOMER_NOT_FOUND' })
  })

  it('records OUTLET_CONTEXT_NOT_FOUND when a provided outlet context is missing', async () => {
    lstate.skipOutletSelect = false
    lstate.outletRows = []
    const res = await syncLeads(
      makeLeadTx() as never,
      COMPANY_ID,
      leadInput({ outlet_context_code: 'MISSING-OUTLET' }) as never
    )
    expect(res.data.failed).toBe(1)
    expect(lstate.insertCalls).toBe(0)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'OUTLET_CONTEXT_NOT_FOUND' })
  })

  it('maps a duplicate visit plan (unique violation) to non-fatal LEAD_DUPLICATE', async () => {
    lstate.throwOnInsert = Object.assign(new Error('dup'), { code: '23505' })
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.created).toBe(0)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'LEAD_DUPLICATE' })
  })

  it('captures an unexpected DB error as LEAD_UPSERT_FAILED', async () => {
    lstate.throwOnInsert = new Error('connection lost')
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.failed).toBe(1)
    expect(res.data.errors[0]).toMatchObject({ index: 0, code: 'LEAD_UPSERT_FAILED' })
  })

  it('short-circuits duplicate idempotency_key without applying', async () => {
    redisClaim.result = null
    const res = await syncLeads(makeLeadTx() as never, COMPANY_ID, leadInput() as never)
    expect(res.data.duplicate).toBe(true)
    expect(res.data.received).toBe(1)
    expect(res.data.created).toBe(0)
    expect(lstate.insertCalls).toBe(0)
  })
})
