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
  time,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core'
import { geometry } from 'drizzle-orm/pg-core'
import { companies, masterSoffice } from './tenant'
import { appUsers } from './auth'

// --- Enums ---

export const customerTypeEnum = pgEnum('customer_type_enum', [
  'OUTLET',
  'DOCTOR',
  'COMMUNITY',
  'EVENT',
])

// --- Tables ---

export const masterCustomer = pgTable(
  'master_customer',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sofficeId: uuid('soffice_id').notNull().references(() => masterSoffice.id),
    customerType: customerTypeEnum('customer_type').notNull().default('OUTLET'),
    erpCustomerCode: varchar('erp_customer_code', { length: 100 }),
    name: varchar({ length: 255 }).notNull(),
    customerGroup: varchar('customer_group', { length: 100 }),
    address: text(),
    city: varchar({ length: 100 }),
    locationGeom: geometry('location_geom', { type: 'point', srid: 4326 }),
    creditLimit: numeric('credit_limit', { precision: 15, scale: 2 }).default('0'),
    creditTermDays: integer('credit_term_days').default(30),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_customer_company').on(table.companyId, table.customerType, table.isActive),
    uniqueIndex('uq_customer_active_code').on(table.companyId, table.erpCustomerCode),
  ],
)

export const doctorProfiles = pgTable(
  'doctor_profiles',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').unique().notNull().references(() => masterCustomer.id, { onDelete: 'cascade' }),
    sipStrNumber: varchar('sip_str_number', { length: 100 }),
    specialization: varchar({ length: 100 }),
    subSpecialization: varchar('sub_specialization', { length: 100 }),
    practiceSchedule: jsonb('practice_schedule'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_doctor_profile_specialization').on(table.companyId, table.specialization),
  ],
)

export const doctorOutletAssignments = pgTable(
  'doctor_outlet_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    doctorCustomerId: uuid('doctor_customer_id').notNull().references(() => masterCustomer.id, { onDelete: 'cascade' }),
    outletCustomerId: uuid('outlet_customer_id').notNull().references(() => masterCustomer.id, { onDelete: 'cascade' }),
    roomOrDepartment: varchar('room_or_department', { length: 100 }),
    isPrimaryPractice: boolean('is_primary_practice').default(false),
    practiceDays: varchar('practice_days', { length: 50 }),
    practiceHoursStart: time('practice_hours_start'),
    practiceHoursEnd: time('practice_hours_end'),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_doc_outlet_doc').on(table.doctorCustomerId),
    index('idx_doc_outlet_outlet').on(table.outletCustomerId),
    unique('uq_doctor_outlet').on(table.companyId, table.doctorCustomerId, table.outletCustomerId),
  ],
)

export const masterPic = pgTable(
  'master_pic',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull().references(() => masterCustomer.id, { onDelete: 'cascade' }),
    picName: varchar('pic_name', { length: 150 }).notNull(),
    positionTitle: varchar('position_title', { length: 100 }),
    phone: varchar({ length: 50 }),
    isPrimary: boolean('is_primary').default(false),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_pic_customer').on(table.customerId),
  ],
)
