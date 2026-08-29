import type { ERPSystemType } from './enums.js';

/** Represents the `companies` table — tenant root entity */
export interface Company {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  logo_s3_key: string | null;
  default_tax_rate: number;
  geofence_radius_meters: number;
  erp_system_type: ERPSystemType | null;
  erp_endpoint_url: string | null;
  erp_auth_config: Record<string, unknown> | null;
  erp_company_code: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `master_soffice` table — branch sales office */
export interface SalesOffice {
  id: string;
  company_id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  province: string | null;
  location_geom: GeoPoint | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** GeoJSON-style point for spatial data */
export interface GeoPoint {
  lat: number;
  lng: number;
}
