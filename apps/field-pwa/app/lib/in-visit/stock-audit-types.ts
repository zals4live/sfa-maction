/**
 * API response shape for a `visit_stock_audits` record as returned by the backend.
 *
 * Mirrors `services/api-server/src/modules/visit/schemas.ts` → `StockAuditResponse`
 * (snake_case, `physical_stock_qty` / `estimated_days_of_stock`). This differs from the
 * shared `@maction/types` `VisitStockAudit` interface (`qty`), which models the raw DB row
 * rather than the HTTP contract — so `StockAuditForm.vue` types its online POST result
 * against this local shape to stay faithful to what `POST /visits/:id/stock-audits`
 * actually returns.
 */
export interface StockAuditResponse {
  id: string
  visit_id: string
  material_id: string
  physical_stock_qty: number
  uom: string
  estimated_days_of_stock: number | null
  created_at: string
}
