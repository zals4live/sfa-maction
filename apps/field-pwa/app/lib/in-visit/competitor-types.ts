/**
 * API response shape for a `visit_competitor_audits` record as returned by the backend.
 *
 * Mirrors `services/api-server/src/modules/visit/schemas.ts` → `CompetitorAuditResponse`
 * (snake_case). `CompetitorForm.vue` types its online POST result against this local shape to
 * stay faithful to what `POST /visits/:id/competitor-audits` actually returns.
 */
export interface CompetitorAuditResponse {
  id: string
  visit_id: string
  competitor_brand: string
  competitor_product: string
  price_to_pharmacy: number | null
  consumer_price: number | null
  active_promo_notes: string | null
  photo_s3_key: string | null
  created_at: string
}
