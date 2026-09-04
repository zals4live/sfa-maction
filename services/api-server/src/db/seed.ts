/**
 * Database seed script — KF Maction v2.0 (LOCAL DEV).
 *
 * Populates a minimal but fully usable dataset so the Web Portal and Field PWA can be
 * exercised end-to-end (login, lini-scoped material catalog, price/stock lookup, and a
 * sample outlet + doctor to visit).
 *
 * Design notes:
 *  - Idempotent: every insert uses `onConflictDoNothing` against the table's natural
 *    unique key (code / email), so running it repeatedly is safe and never duplicates.
 *  - Runs as the DB owner (`dbmaction_v2`), which bypasses RLS since no table has
 *    FORCE ROW LEVEL SECURITY — inserts are not blocked by tenant policies.
 *  - Passwords are hashed with `Bun.password.hash` (matches `Bun.password.verify` used
 *    by the auth service).
 *
 * Run with:  bun run db:seed
 */

import { eq, and, sql } from 'drizzle-orm'

import { db } from './index'
import { sql as pgClient } from '../config/database'
import { companies, masterSoffice, masterLini, masterVarian } from './schema/tenant'
import { appUsers, userLiniAssignments } from './schema/auth'
import { masterCustomer, doctorProfiles, doctorOutletAssignments, masterPic } from './schema/customer'
import { masterMaterial, masterPrice, stockInventoryAtp } from './schema/material'

// --- Shared constants -------------------------------------------------------

const COMPANY_CODE = 'KFTD'
const SOFFICE_CODE = 'SO-JKT-01'
const DEFAULT_PASSWORD = 'Password123!'

// Jakarta reference point (Kimia Farma HO area) for geospatial demo data.
const JKT_LNG = 106.8272
const JKT_LAT = -6.1751

// PostGIS point value (SRID 4326) built via raw SQL for `geometry` columns.
function point(lng: number, lat: number) {
  return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
}

// --- Helpers ---------------------------------------------------------------

/** Insert-or-fetch a row by a unique lookup, returning its id. */
async function upsertReturningId<T extends { id: string }>(
  label: string,
  find: () => Promise<T | undefined>,
  insert: () => Promise<void>
): Promise<string> {
  const existing = await find()
  if (existing) {
    console.log(`  ↩︎  ${label} already exists (${existing.id})`)
    return existing.id
  }
  await insert()
  const created = await find()
  if (!created) throw new Error(`Failed to create ${label}`)
  console.log(`  ✅ ${label} created (${created.id})`)
  return created.id
}

// --- Seed steps -------------------------------------------------------------

async function seedCompany(): Promise<string> {
  return upsertReturningId(
    `company ${COMPANY_CODE}`,
    async () => (await db.select().from(companies).where(eq(companies.code, COMPANY_CODE)).limit(1))[0],
    async () => {
      await db.insert(companies).values({
        code: COMPANY_CODE,
        name: 'Kimia Farma Trading & Distribution',
        erpSystemType: 'SAP_S4HANA',
        defaultTaxRate: '11.00',
        geofenceRadiusMeters: 100,
        checkoutMinHour: 16,
        isActive: true,
      }).onConflictDoNothing()
    }
  )
}

async function seedSoffice(companyId: string): Promise<string> {
  return upsertReturningId(
    `soffice ${SOFFICE_CODE}`,
    async () =>
      (await db.select().from(masterSoffice)
        .where(and(eq(masterSoffice.companyId, companyId), eq(masterSoffice.code, SOFFICE_CODE)))
        .limit(1))[0],
    async () => {
      await db.insert(masterSoffice).values({
        companyId,
        code: SOFFICE_CODE,
        name: 'Sales Office Jakarta Pusat',
        address: 'Jl. Veteran No. 9, Jakarta Pusat',
        city: 'Jakarta',
        locationGeom: point(JKT_LNG, JKT_LAT),
        isActive: true,
      }).onConflictDoNothing()
    }
  )
}

interface LiniSeed { code: string, name: string }
const LINI_SEEDS: LiniSeed[] = [
  { code: 'FARMA_ETHICAL', name: 'Farma Ethical' },
  { code: 'FARMA_GENERIK', name: 'Farma Generik' },
  { code: 'OTC', name: 'Over The Counter' },
]

async function seedLini(companyId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  for (const lini of LINI_SEEDS) {
    ids[lini.code] = await upsertReturningId(
      `lini ${lini.code}`,
      async () =>
        (await db.select().from(masterLini)
          .where(and(eq(masterLini.companyId, companyId), eq(masterLini.code, lini.code)))
          .limit(1))[0],
      async () => {
        await db.insert(masterLini).values({
          companyId, code: lini.code, name: lini.name, isActive: true,
        }).onConflictDoNothing()
      }
    )
  }
  return ids
}

async function seedVarian(companyId: string): Promise<string> {
  return upsertReturningId(
    'varian REGULAR',
    async () =>
      (await db.select().from(masterVarian)
        .where(and(eq(masterVarian.companyId, companyId), eq(masterVarian.code, 'REGULAR')))
        .limit(1))[0],
    async () => {
      await db.insert(masterVarian).values({
        companyId, code: 'REGULAR', name: 'Regular', isActive: true,
      }).onConflictDoNothing()
    }
  )
}

interface UserSeed {
  email: string
  fullName: string
  role: 'SUPER_ADMIN' | 'ADMIN_PUSAT' | 'ADMIN_CABANG' | 'SALESMAN' | 'MR'
  liniCodes: string[]
}

const USER_SEEDS: UserSeed[] = [
  { email: 'superadmin@maction.test', fullName: 'Super Admin', role: 'SUPER_ADMIN', liniCodes: [] },
  { email: 'adminpusat@maction.test', fullName: 'Admin Pusat', role: 'ADMIN_PUSAT', liniCodes: [] },
  { email: 'admincabang@maction.test', fullName: 'Admin Cabang Jakarta', role: 'ADMIN_CABANG', liniCodes: [] },
  { email: 'salesman@maction.test', fullName: 'Budi Salesman', role: 'SALESMAN', liniCodes: ['FARMA_ETHICAL', 'FARMA_GENERIK', 'OTC'] },
  { email: 'mr@maction.test', fullName: 'Siti Medical Rep', role: 'MR', liniCodes: ['FARMA_ETHICAL'] },
]

async function seedUsers(
  companyId: string,
  sofficeId: string,
  liniIds: Record<string, string>
): Promise<void> {
  const passwordHash = await Bun.password.hash(DEFAULT_PASSWORD)

  for (const u of USER_SEEDS) {
    const userId = await upsertReturningId(
      `user ${u.email} (${u.role})`,
      async () => (await db.select().from(appUsers).where(eq(appUsers.email, u.email)).limit(1))[0],
      async () => {
        await db.insert(appUsers).values({
          companyId,
          sofficeId,
          email: u.email,
          passwordHash,
          fullName: u.fullName,
          roleLabel: u.role,
          isActive: true,
        }).onConflictDoNothing()
      }
    )

    // Assign business lines (M:N) for field roles.
    for (const code of u.liniCodes) {
      const liniId = liniIds[code]
      if (!liniId) continue
      await db.insert(userLiniAssignments).values({
        companyId, userId, liniId, isActive: true,
      }).onConflictDoNothing()
    }
    if (u.liniCodes.length > 0) {
      console.log(`     ↳ assigned lini: ${u.liniCodes.join(', ')}`)
    }
  }
}

interface MaterialSeed {
  code: string
  name: string
  liniCode: string
  priceRegular: string
  batch: string
  qty: string
}

const MATERIAL_SEEDS: MaterialSeed[] = [
  { code: 'MAT-0001', name: 'Fituno Tablet', liniCode: 'FARMA_ETHICAL', priceRegular: '55000.00', batch: 'B2601', qty: '480' },
  { code: 'MAT-0002', name: 'Paracetamol 500mg', liniCode: 'FARMA_GENERIK', priceRegular: '12000.00', batch: 'B2602', qty: '1200' },
  { code: 'MAT-0003', name: 'Batugin Elixir', liniCode: 'OTC', priceRegular: '28000.00', batch: 'B2603', qty: '300' },
]

async function seedMaterials(
  companyId: string,
  sofficeId: string,
  varianId: string,
  liniIds: Record<string, string>
): Promise<void> {
  const validFrom = '2026-01-01'
  const validTo = '2026-12-31'

  for (const m of MATERIAL_SEEDS) {
    const materialId = await upsertReturningId(
      `material ${m.code}`,
      async () =>
        (await db.select().from(masterMaterial)
          .where(and(eq(masterMaterial.companyId, companyId), eq(masterMaterial.erpMaterialCode, m.code)))
          .limit(1))[0],
      async () => {
        await db.insert(masterMaterial).values({
          companyId,
          erpMaterialCode: m.code,
          name: m.name,
          baseUom: 'PCS',
          salesUom: 'BOX',
          liniId: liniIds[m.liniCode],
          uomConversionRules: { levels: [{ uom: 'BOX', factor: 10 }, { uom: 'PCS', factor: 1 }] },
          isActive: true,
        }).onConflictDoNothing()
      }
    )

    // Price (branch-scoped).
    await db.insert(masterPrice).values({
      companyId,
      sofficeId,
      materialId,
      varianId,
      priceRegular: m.priceRegular,
      per: 1,
      salesUom: 'BOX',
      validFrom,
      validTo,
    }).onConflictDoNothing()

    // ATP stock (branch + batch).
    await db.insert(stockInventoryAtp).values({
      companyId,
      sofficeId,
      materialId,
      varianId,
      batch: m.batch,
      sled: '2027-06-30',
      qtyAvailable: m.qty,
      qtyAllocated: '0',
      uom: 'BOX',
    }).onConflictDoNothing()
  }
}

async function seedCustomers(companyId: string, sofficeId: string): Promise<void> {
  // Outlet
  const outletId = await upsertReturningId(
    'outlet APT-0001',
    async () =>
      (await db.select().from(masterCustomer)
        .where(and(eq(masterCustomer.companyId, companyId), eq(masterCustomer.erpCustomerCode, 'APT-0001')))
        .limit(1))[0],
    async () => {
      await db.insert(masterCustomer).values({
        companyId,
        sofficeId,
        customerType: 'OUTLET',
        erpCustomerCode: 'APT-0001',
        name: 'Apotek Sehat Sentosa',
        customerGroup: 'APOTEK',
        address: 'Jl. Merdeka No. 12, Jakarta Pusat',
        city: 'Jakarta',
        locationGeom: point(JKT_LNG + 0.001, JKT_LAT + 0.001),
        isActive: true,
      }).onConflictDoNothing()
    }
  )

  await db.insert(masterPic).values({
    companyId,
    customerId: outletId,
    picName: 'Apt. Dewi Lestari',
    positionTitle: 'Apoteker Penanggung Jawab',
    phone: '081200000001',
    isPrimary: true,
  }).onConflictDoNothing()

  // Doctor
  const doctorId = await upsertReturningId(
    'doctor DOC-0001',
    async () =>
      (await db.select().from(masterCustomer)
        .where(and(eq(masterCustomer.companyId, companyId), eq(masterCustomer.erpCustomerCode, 'DOC-0001')))
        .limit(1))[0],
    async () => {
      await db.insert(masterCustomer).values({
        companyId,
        sofficeId,
        customerType: 'DOCTOR',
        erpCustomerCode: 'DOC-0001',
        name: 'dr. Andi Wijaya, Sp.PD',
        address: 'Jl. Merdeka No. 12, Jakarta Pusat',
        city: 'Jakarta',
        locationGeom: point(JKT_LNG + 0.001, JKT_LAT + 0.001),
        isActive: true,
      }).onConflictDoNothing()
    }
  )

  // Doctor profile (1:1 with customer)
  const existingProfile = (await db.select().from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, doctorId)).limit(1))[0]
  if (!existingProfile) {
    await db.insert(doctorProfiles).values({
      companyId,
      customerId: doctorId,
      sipStrNumber: 'STR-123456',
      specialization: 'Penyakit Dalam',
    }).onConflictDoNothing()
    console.log('  ✅ doctor profile created')
  } else {
    console.log('  ↩︎  doctor profile already exists')
  }

  // Doctor practises at the outlet (M:N)
  await db.insert(doctorOutletAssignments).values({
    companyId,
    doctorCustomerId: doctorId,
    outletCustomerId: outletId,
    roomOrDepartment: 'Poli Penyakit Dalam',
    isPrimaryPractice: true,
    practiceDays: 'MON,WED,FRI',
    isActive: true,
  }).onConflictDoNothing()
}

// --- Entrypoint -------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🌱 Seeding KF Maction dev database...\n')

  console.log('▸ Company')
  const companyId = await seedCompany()

  console.log('▸ Sales Office')
  const sofficeId = await seedSoffice(companyId)

  console.log('▸ Business Lines (Lini)')
  const liniIds = await seedLini(companyId)

  console.log('▸ Varian')
  const varianId = await seedVarian(companyId)

  console.log('▸ Users')
  await seedUsers(companyId, sofficeId, liniIds)

  console.log('▸ Materials + Price + Stock')
  await seedMaterials(companyId, sofficeId, varianId, liniIds)

  console.log('▸ Customers (Outlet + Doctor)')
  await seedCustomers(companyId, sofficeId)

  console.log('\n✅ Seed complete.')
  console.log('\n── Login credentials ─────────────────────────────')
  console.log(`   Password for ALL accounts: ${DEFAULT_PASSWORD}`)
  for (const u of USER_SEEDS) {
    console.log(`   ${u.role.padEnd(12)} ${u.email}`)
  }
  console.log('──────────────────────────────────────────────────')
}

main()
  .then(async () => {
    await pgClient.end()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('\n❌ Seed failed:', err)
    await pgClient.end()
    process.exit(1)
  })
