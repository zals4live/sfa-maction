import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core'
import { companies, masterSoffice, masterLini, masterVarian } from './tenant'
import { appUsers } from './auth'

// --- Enums ---

export const promoTypeEnum = pgEnum('promo_type_enum', [
  'PERCENT_DISCOUNT',
  'FIXED_AMOUNT',
  'FREE_GOODS',
  'BUNDLING',
])

// --- Tables ---

export const masterMaterial = pgTable(
  'master_material',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    erpMaterialCode: varchar('erp_material_code', { length: 100 }).notNull(),
    name: varchar({ length: 255 }).notNull(),
    baseUom: varchar('base_uom', { length: 20 }).notNull(),
    salesUom: varchar('sales_uom', { length: 20 }).notNull(),
    nie: varchar({ length: 100 }),
    validNie: date('valid_nie'),
    liniId: uuid('lini_id').references(() => masterLini.id),
    manufacture: varchar({ length: 255 }),
    principal: varchar({ length: 255 }),
    uomConversionRules: jsonb('uom_conversion_rules').notNull(),
    isNarcoticPsychotropic: boolean('is_narcotic_psychotropic').default(false),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_material_company').on(table.companyId, table.liniId, table.isActive),
    uniqueIndex('uq_material_active_code').on(table.companyId, table.erpMaterialCode),
  ],
)

export const masterPrice = pgTable(
  'master_price',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sofficeId: uuid('soffice_id').notNull().references(() => masterSoffice.id),
    materialId: uuid('material_id').notNull().references(() => masterMaterial.id, { onDelete: 'cascade' }),
    varianId: uuid('varian_id').references(() => masterVarian.id),
    priceRegular: numeric('price_regular', { precision: 15, scale: 2 }).notNull(),
    priceHja: numeric('price_hja', { precision: 15, scale: 2 }),
    priceHet: numeric('price_het', { precision: 15, scale: 2 }),
    per: integer().notNull().default(1),
    salesUom: varchar('sales_uom', { length: 20 }).notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_price_lookup').on(table.sofficeId, table.materialId, table.varianId, table.validFrom, table.validTo),
    unique('uq_price_branch_mat_var').on(table.companyId, table.sofficeId, table.materialId, table.varianId, table.validFrom),
  ],
)

export const stockInventoryAtp = pgTable(
  'stock_inventory_atp',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sofficeId: uuid('soffice_id').notNull().references(() => masterSoffice.id),
    materialId: uuid('material_id').notNull().references(() => masterMaterial.id, { onDelete: 'cascade' }),
    varianId: uuid('varian_id').references(() => masterVarian.id),
    batch: varchar({ length: 100 }).notNull(),
    sled: date(),
    qtyAvailable: numeric('qty_available', { precision: 12, scale: 2 }).notNull().default('0'),
    qtyAllocated: numeric('qty_allocated', { precision: 12, scale: 2 }).notNull().default('0'),
    stockValue: numeric('stock_value', { precision: 15, scale: 2 }).default('0'),
    uom: varchar({ length: 20 }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_stock_lookup').on(table.sofficeId, table.materialId, table.varianId, table.sled),
    unique('uq_stock_batch').on(table.companyId, table.sofficeId, table.materialId, table.varianId, table.batch),
  ],
)

export const masterPromotions = pgTable(
  'master_promotions',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    promoCode: varchar('promo_code', { length: 100 }).notNull(),
    promoName: varchar('promo_name', { length: 255 }).notNull(),
    promoType: promoTypeEnum('promo_type').notNull(),
    discountPercentage: numeric('discount_percentage', { precision: 5, scale: 2 }).default('0'),
    discountAmount: numeric('discount_amount', { precision: 15, scale: 2 }).default('0'),
    minOrderQty: integer('min_order_qty').default(1),
    freeMaterialId: uuid('free_material_id').references(() => masterMaterial.id),
    freeMaterialQty: integer('free_material_qty').default(0),
    validStart: timestamp('valid_start', { withTimezone: true, mode: 'string' }).notNull(),
    validEnd: timestamp('valid_end', { withTimezone: true, mode: 'string' }).notNull(),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_promo_active_code').on(table.companyId, table.promoCode),
  ],
)
