import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  date,
  index,
  unique,
} from 'drizzle-orm/pg-core'
import { geometry } from 'drizzle-orm/pg-core'
import { companies, masterSoffice, masterLini } from './tenant'

// --- Enums ---

export const userLabelEnum = pgEnum('user_label_enum', [
  'SUPER_ADMIN',
  'ADMIN_PUSAT',
  'ADMIN_CABANG',
  'SALESMAN',
  'MR',
])

export const attendanceTypeEnum = pgEnum('attendance_type_enum', [
  'OFFICE',
  'CUSTOMER',
  'OTHER',
])

// --- Tables ---

export const appUsers = pgTable(
  'app_users',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sofficeId: uuid('soffice_id').references(() => masterSoffice.id),
    email: varchar({ length: 150 }).unique().notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 150 }).notNull(),
    phoneNumber: varchar('phone_number', { length: 30 }),
    roleLabel: userLabelEnum('role_label').notNull(),
    avatarS3Key: text('avatar_s3_key'),
    currentSessionIp: varchar('current_session_ip', { length: 45 }),
    isActive: boolean('is_active').default(true),
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_users_company_soffice').on(table.companyId, table.sofficeId),
    index('idx_users_role').on(table.companyId, table.roleLabel),
  ],
)

export const userLiniAssignments = pgTable(
  'user_lini_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
    liniId: uuid('lini_id').notNull().references(() => masterLini.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_user_lini_user').on(table.userId),
    index('idx_user_lini_lookup').on(table.companyId, table.userId, table.liniId),
    unique('uq_user_lini').on(table.companyId, table.userId, table.liniId),
  ],
)

export const absensi = pgTable(
  'absensi',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
    attendanceDate: date('attendance_date').notNull(),
    attendanceType: attendanceTypeEnum('attendance_type').notNull(),
    checkInTime: timestamp('check_in_time', { withTimezone: true, mode: 'string' }).notNull(),
    checkInGeom: geometry('check_in_geom', { type: 'point', srid: 4326 }).notNull(),
    checkInPhotoS3Key: text('check_in_photo_s3_key').notNull(),
    checkInDistanceMeters: integer('check_in_distance_meters'),
    checkOutTime: timestamp('check_out_time', { withTimezone: true, mode: 'string' }),
    checkOutGeom: geometry('check_out_geom', { type: 'point', srid: 4326 }),
    checkOutPhotoS3Key: text('check_out_photo_s3_key'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_absensi_company_date').on(table.companyId, table.attendanceDate),
    unique('uq_user_attendance_date').on(table.companyId, table.userId, table.attendanceDate),
  ],
)
