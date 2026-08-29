import type { CustomerType } from './enums.js';
import type { GeoPoint } from './tenant.js';

/** Represents the `master_customer` table — unified outlet/person entity */
export interface MasterCustomer {
  id: string;
  company_id: string;
  soffice_id: string;
  customer_type: CustomerType;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  province: string | null;
  phone: string | null;
  email: string | null;
  location_geom: GeoPoint | null;
  erp_customer_code: string | null;
  credit_limit: number | null;
  credit_used: number | null;
  is_active: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `doctor_profiles` table — 1:1 extension for doctor entities */
export interface DoctorProfile {
  id: string;
  company_id: string;
  customer_id: string;
  specialization: string | null;
  sip_number: string | null;
  practice_schedule: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `doctor_outlet_assignments` table — M:N doctor-to-outlet */
export interface DoctorOutletAssignment {
  id: string;
  company_id: string;
  doctor_customer_id: string;
  outlet_customer_id: string;
  room: string | null;
  department: string | null;
  practice_days: string[] | null;
  practice_hours: string | null;
  is_primary: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `master_pic` table — outlet staff contacts */
export interface MasterPIC {
  id: string;
  company_id: string;
  customer_id: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
