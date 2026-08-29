import type { VisitType } from './enums.js';
import type { GeoPoint } from './tenant.js';

/** Represents the `visit_plans` table — monthly scheduled visits (MVP/SCP) */
export interface VisitPlan {
  id: string;
  company_id: string;
  user_id: string;
  customer_id: string;
  outlet_context_id: string | null;
  plan_date: string;
  notes: string | null;
  is_completed: boolean;
  created_at: string;
  updated_at: string;
}

/** Represents the `visits` table — executed visit records */
export interface Visit {
  id: string;
  company_id: string;
  user_id: string;
  customer_id: string;
  outlet_context_id: string | null;
  visit_plan_id: string | null;
  visit_type: VisitType;
  visit_in_at: string;
  visit_in_geom: GeoPoint;
  visit_in_accuracy_meters: number;
  visit_in_mono_delta_ms: number;
  visit_out_at: string | null;
  visit_out_geom: GeoPoint | null;
  visit_out_accuracy_meters: number | null;
  visit_out_mono_delta_ms: number | null;
  signature_s3_key: string | null;
  distance_to_target_meters: number;
  created_at: string;
  updated_at: string;
}

/** Represents the `visit_agendas` table — detailing/meeting notes per visit */
export interface VisitAgenda {
  id: string;
  company_id: string;
  visit_id: string;
  topic: string;
  product_id: string | null;
  summary: string | null;
  photo_s3_key: string | null;
  created_at: string;
}

/** Represents the `visit_stock_audits` table — shelf stock observations */
export interface VisitStockAudit {
  id: string;
  company_id: string;
  visit_id: string;
  material_id: string;
  qty: number;
  uom: string;
  estimated_days_of_stock: number | null;
  created_at: string;
}

/** Represents the `visit_competitor_audits` table — competitor intel */
export interface VisitCompetitorAudit {
  id: string;
  company_id: string;
  visit_id: string;
  brand: string;
  product: string;
  price: number | null;
  promo_notes: string | null;
  photo_s3_key: string | null;
  created_at: string;
}
