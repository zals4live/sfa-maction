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
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { geometry } from 'drizzle-orm/pg-core'

// --- Enums ---

export const erpSystemEnum = pgEnum('erp_system_enum', [
  'SAP_S4HANA',
  'SAP_ECC',
  'QAD',
  'CUSTOM_REST',
])

// --- Tables ---

export const companies = pgTable('companies', {
  id: uuid().primaryKey().defaultRandom(),
  code: varchar({ length: 50 }).unique().notNull(),
  name: varchar({ length: 255 }).notNull(),
  logoS3Key: text('logo_s3_key'),
  erpSystemType: erpSystemEnum('erp_system_type').default('SAP_S4HANA'),
  erpEndpointUrl: text('erp_endpoint_url'),
  erpAuthConfig: jsonb('erp_auth_config'),
  erpCompanyCode: varchar('erp_company_code', { length: 50 }),
  defaultTaxRate: numeric('default_tax_rate', { precision: 5, scale: 2 }).default('11.00'),
  geofenceRadiusMeters: integer('geofence_radius_meters').default(100),
  checkoutMinHour: integer('checkout_min_hour').default(16),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
})

export const masterSoffice = pgTable(
  'master_soffice',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    code: varchar({ length: 50 }).notNull(),
    name: varchar({ length: 150 }).notNull(),
    address: text(),
    city: varchar({ length: 100 }),
    locationGeom: geometry('location_geom', { type: 'point', srid: 4326 }),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_soffice_company').on(table.companyId),
    uniqueIndex('uq_soffice_active_code').on(table.companyId, table.code),
  ],
)

export const masterLini = pgTable(
  'master_lini',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    code: varchar({ length: 50 }).notNull(),
    name: varchar({ length: 150 }).notNull(),
    description: text(),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_lini_company').on(table.companyId, table.isActive),
    uniqueIndex('uq_lini_active_code').on(table.companyId, table.code),
  ],
)

export const masterVarian = pgTable(
  'master_varian',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    code: varchar({ length: 50 }).notNull(),
    name: varchar({ length: 150 }).notNull(),
    description: text(),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_varian_company').on(table.companyId, table.isActive),
    uniqueIndex('uq_varian_active_code').on(table.companyId, table.code),
  ],
)
