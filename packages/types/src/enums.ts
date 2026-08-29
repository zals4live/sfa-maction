/** Matches PostgreSQL: erp_system_enum */
export enum ERPSystemType {
  SAP_S4HANA = 'SAP_S4HANA',
  SAP_ECC = 'SAP_ECC',
  QAD = 'QAD',
  CUSTOM_REST = 'CUSTOM_REST',
}

/** Matches PostgreSQL: user_label_enum */
export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN_PUSAT = 'ADMIN_PUSAT',
  ADMIN_CABANG = 'ADMIN_CABANG',
  SALESMAN = 'SALESMAN',
}

/** Matches PostgreSQL: business_line_enum */
export enum BusinessLine {
  PHARMA = 'PHARMA',
  OTC_HERBAL = 'OTC_HERBAL',
  KOSMETIK = 'KOSMETIK',
  ALKES = 'ALKES',
}

/** Matches PostgreSQL: attendance_type_enum */
export enum AttendanceType {
  OFFICE = 'OFFICE',
  CUSTOMER = 'CUSTOMER',
  OTHER = 'OTHER',
}

/** Matches PostgreSQL: customer_type_enum */
export enum CustomerType {
  OUTLET = 'OUTLET',
  PERSON = 'PERSON',
  COMMUNITY = 'COMMUNITY',
  EVENT = 'EVENT',
}

/** Matches PostgreSQL: visit_type_enum */
export enum VisitType {
  PLANNED = 'PLANNED',
  EXTRA = 'EXTRA',
}

/** Matches PostgreSQL: sync_status_enum */
export enum SyncStatus {
  PENDING = 'PENDING',
  SYNCED = 'SYNCED',
  FAILED = 'FAILED',
}

/** Matches PostgreSQL: order_status_enum */
export enum OrderStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  SYNCED_ERP = 'SYNCED_ERP',
  REJECTED_ERP = 'REJECTED_ERP',
  CANCELLED = 'CANCELLED',
}

/** Matches PostgreSQL: promo_type_enum */
export enum PromoType {
  PERCENT_DISCOUNT = 'PERCENT_DISCOUNT',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  FREE_GOODS = 'FREE_GOODS',
  BUNDLING = 'BUNDLING',
}

/** Matches PostgreSQL: fraud_type_enum */
export enum FraudType {
  MOCK_LOCATION = 'MOCK_LOCATION',
  VELOCITY_ANOMALY = 'VELOCITY_ANOMALY',
  ACCURACY_EXCESS = 'ACCURACY_EXCESS',
  CLOCK_DRIFT = 'CLOCK_DRIFT',
}
