/**
 * API response shape for a `visit_agendas` record as returned by the backend.
 *
 * Mirrors `services/api-server/src/modules/visit/schemas.ts` → `AgendaResponse` (snake_case,
 * `product_discussed_id` / `discussion_summary`). This differs from the shared
 * `@maction/types` `VisitAgenda` interface (`product_id` / `summary`), which models the raw
 * DB row rather than the HTTP contract — so `AgendaForm.vue` types its online POST result
 * against this local shape to stay faithful to what `POST /visits/:id/agendas` actually
 * returns.
 */
export interface AgendaResponse {
  id: string
  visit_id: string
  topic: string
  product_discussed_id: string | null
  discussion_summary: string | null
  photo_s3_key: string | null
  created_at: string
}
