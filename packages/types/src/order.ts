import type { OrderStatus } from './enums.js';

/** Represents the `orders` table — order header with totals */
export interface Order {
  id: string;
  company_id: string;
  user_id: string;
  soffice_id: string;
  customer_id: string;
  doctor_customer_id: string | null;
  visit_id: string | null;
  order_number: string;
  order_status: OrderStatus;
  subtotal: number;
  total_discount: number;
  tax_rate: number;
  tax_amount: number;
  grand_total: number;
  pdf_quotation_s3_key: string | null;
  erp_quotation_id: string | null;
  idempotency_key: string;
  submitted_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents the `order_items` table — line items with pricing */
export interface OrderItem {
  id: string;
  company_id: string;
  order_id: string;
  material_id: string;
  material_name: string;
  qty: number;
  uom: string;
  base_qty: number;
  price_per_base_uom: number;
  line_subtotal: number;
  discount_amount: number;
  line_total: number;
  promotion_id: string | null;
  created_at: string;
}
