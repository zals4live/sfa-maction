import type { BusinessLine, PromoType } from './enums.js';

/** UOM conversion rules — maps UOM code to quantity multiplier relative to base unit */
export interface UOMConversionRules {
  [uomCode: string]: number;
}

/** Represents the `master_material` table — SKU catalog */
export interface MasterMaterial {
  id: string;
  company_id: string;
  code: string;
  name: string;
  description: string | null;
  business_line: BusinessLine;
  base_uom: string;
  uom_conversion_rules: UOMConversionRules;
  erp_material_code: string | null;
  is_active: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `master_price` table — branch-specific pricing */
export interface MasterPrice {
  id: string;
  company_id: string;
  soffice_id: string;
  material_id: string;
  price_per_base_uom: number;
  currency: string;
  valid_from: string;
  valid_to: string;
  created_at: string;
  updated_at: string;
}

/** Represents the `stock_inventory_atp` table — available-to-promise stock */
export interface StockInventoryATP {
  id: string;
  company_id: string;
  soffice_id: string;
  material_id: string;
  available_qty: number;
  uom: string;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

/** Represents the `master_promotions` table — active promotion programs */
export interface MasterPromotion {
  id: string;
  company_id: string;
  name: string;
  promo_type: PromoType;
  discount_value: number | null;
  free_goods_material_id: string | null;
  free_goods_qty: number | null;
  min_order_qty: number | null;
  min_order_amount: number | null;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
