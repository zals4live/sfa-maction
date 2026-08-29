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
  index,
  unique,
} from 'drizzle-orm/pg-core'
import { geometry } from 'drizzle-orm/pg-core'
import { companies } from './tenant'
import { appUsers } from './auth'
import { masterCustomer, masterPic } from './customer'
import { masterMaterial } from './material'

// --- Enums ---

export const visitTypeEnum = pgEnum('visit_type_enum', ['PLANNED', 'EXTRA'])

export const syncStatusEnum = pgEnum('sync_status_enum', ['PENDING', 'SYNCED', 'FAILED'])

// --- Tables ---

export const visitPlans = pgTable(
  'visit_plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id),
    customerId: uuid('customer_id').notNull().references(() => masterCustomer.id),
    outletContextId: uuid('outlet_context_id').references(() => masterCustomer.id),
    planDate: date('plan_date').notNull(),
    isLeadFromErp: boolean('is_lead_from_erp').default(false),
    isApproved: boolean('is_approved').default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_visit_plan_lookup').on(table.companyId, table.userId, table.planDate),
    unique('uq_user_plan_target').on(table.companyId, table.userId, table.customerId, table.outletContextId, table.planDate),
  ],
)

export const visits = pgTable(
  'visits',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id),
    customerId: uuid('customer_id').notNull().references(() => masterCustomer.id),
    outletId: uuid('outlet_id').references(() => masterCustomer.id),
    picId: uuid('pic_id').references(() => masterPic.id),
    visitType: visitTypeEnum('visit_type').default('PLANNED'),
    visitDate: date('visit_date').notNull(),
    visitInAt: timestamp('visit_in_at', { withTimezone: true, mode: 'string' }).notNull(),
    visitInGeom: geometry('visit_in_geom', { type: 'point', srid: 4326 }).notNull(),
    visitInDistanceMeters: integer('visit_in_distance_meters'),
    visitOutAt: timestamp('visit_out_at', { withTimezone: true, mode: 'string' }),
    visitOutGeom: geometry('visit_out_geom', { type: 'point', srid: 4326 }),
    signatureS3Key: text('signature_s3_key'),
    notes: text(),
    syncStatus: syncStatusEnum('sync_status').default('SYNCED'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_visits_company_date').on(table.companyId, table.visitDate),
    index('idx_visits_user').on(table.userId, table.visitDate),
    index('idx_visits_customer_outlet').on(table.customerId, table.outletId),
  ],
)

export const visitAgendas = pgTable('visit_agendas', {
  id: uuid().primaryKey().defaultRandom(),
  visitId: uuid('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
  topic: varchar({ length: 255 }).notNull(),
  productDiscussedId: uuid('product_discussed_id').references(() => masterMaterial.id),
  discussionSummary: text('discussion_summary'),
  photoS3Key: text('photo_s3_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
})

export const visitStockAudits = pgTable('visit_stock_audits', {
  id: uuid().primaryKey().defaultRandom(),
  visitId: uuid('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
  materialId: uuid('material_id').notNull().references(() => masterMaterial.id),
  physicalStockQty: integer('physical_stock_qty').notNull(),
  uom: varchar({ length: 20 }).notNull(),
  estimatedDaysOfStock: integer('estimated_days_of_stock'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
})

export const visitCompetitorAudits = pgTable('visit_competitor_audits', {
  id: uuid().primaryKey().defaultRandom(),
  visitId: uuid('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
  competitorBrand: varchar('competitor_brand', { length: 150 }).notNull(),
  competitorProduct: varchar('competitor_product', { length: 150 }).notNull(),
  priceToPharmacy: numeric('price_to_pharmacy', { precision: 15, scale: 2 }),
  consumerPrice: numeric('consumer_price', { precision: 15, scale: 2 }),
  activePromoNotes: text('active_promo_notes'),
  photoS3Key: text('photo_s3_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
})
