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
  primaryKey,
} from 'drizzle-orm/pg-core'
import { companies, masterSoffice } from './tenant'
import { appUsers } from './auth'
import { masterCustomer } from './customer'
import { masterMaterial, masterPromotions } from './material'
import { visits } from './visit'

// --- Enums ---

export const orderStatusEnum = pgEnum('order_status_enum', [
  'DRAFT',
  'SUBMITTED',
  'SYNCED_ERP',
  'REJECTED_ERP',
  'CANCELLED',
])

// --- Tables ---

export const orders = pgTable(
  'orders',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sofficeId: uuid('soffice_id').notNull().references(() => masterSoffice.id),
    userId: uuid('user_id').notNull().references(() => appUsers.id),
    customerId: uuid('customer_id').notNull().references(() => masterCustomer.id),
    doctorCustomerId: uuid('doctor_customer_id').references(() => masterCustomer.id),
    visitId: uuid('visit_id').references(() => visits.id),
    orderNumber: varchar('order_number', { length: 100 }).unique().notNull(),
    erpQuotationNumber: varchar('erp_quotation_number', { length: 100 }),
    orderDate: date('order_date').notNull(),
    subtotalAmount: numeric('subtotal_amount', { precision: 15, scale: 2 }).notNull(),
    totalDiscountAmount: numeric('total_discount_amount', { precision: 15, scale: 2 }).default('0'),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).default('11.00'),
    taxAmount: numeric('tax_amount', { precision: 15, scale: 2 }).notNull(),
    grandTotal: numeric('grand_total', { precision: 15, scale: 2 }).notNull(),
    orderStatus: orderStatusEnum('order_status').default('DRAFT'),
    erpSyncTimestamp: timestamp('erp_sync_timestamp', { withTimezone: true, mode: 'string' }),
    erpErrorPayload: jsonb('erp_error_payload'),
    pdfQuotationS3Key: text('pdf_quotation_s3_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_orders_company_status').on(table.companyId, table.orderStatus, table.orderDate),
  ],
)

/**
 * Per-tenant, per-day monotonic counter backing gap-free order numbering.
 * A row is upserted atomically per (company_id, order_date); the returned
 * `last_sequence` becomes the NNNN suffix of an `ORD-YYYYMMDD-NNNN` number.
 * The atomic upsert serializes concurrent order creation on the row lock,
 * guaranteeing uniqueness without relying on a COUNT of existing orders.
 */
export const orderSequences = pgTable(
  'order_sequences',
  {
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    orderDate: date('order_date').notNull(),
    lastSequence: integer('last_sequence').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_order_sequences', columns: [table.companyId, table.orderDate] }),
  ],
)

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    materialId: uuid('material_id').notNull().references(() => masterMaterial.id),
    qty: integer().notNull(),
    uom: varchar({ length: 20 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    discountPercentage: numeric('discount_percentage', { precision: 5, scale: 2 }).default('0'),
    discountAmount: numeric('discount_amount', { precision: 15, scale: 2 }).default('0'),
    subtotal: numeric({ precision: 15, scale: 2 }).notNull(),
    promotionId: uuid('promotion_id').references(() => masterPromotions.id),
    isFreeGoods: boolean('is_free_goods').default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_order_items_order').on(table.orderId),
  ],
)
