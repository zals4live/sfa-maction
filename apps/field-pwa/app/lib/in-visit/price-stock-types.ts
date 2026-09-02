/**
 * API response shapes for the MR read-only price & stock lookup, mirroring the backend
 * HTTP contract in `services/api-server/src/modules/material/schemas.ts`
 * (`MaterialPriceResponse` / `MaterialStockResponse`).
 *
 * These deliberately mirror the *HTTP* contract rather than the shared `@maction/types`
 * `MasterPrice` / `StockInventoryATP` interfaces, which model the raw DB rows. The backend
 * exposes regional price tiers (`price_regular` / `price_hja` / `price_het`) priced per a
 * `sales_uom` bundle (`per`), and returns ATP stock as batch-level rows carrying `batch`
 * and `sled` (Shelf Life Expiration Date), FEFO-ordered (earliest SLED first) — none of
 * which the DB-row types express. `PriceStockLookup.vue` types its `GET /materials/:id/price`
 * and `GET /materials/:id/stock` results against these shapes to stay faithful to what the
 * endpoints actually return.
 */

/** A single regional price record — mirrors `GET /materials/:id/price` → `data`. */
export interface MaterialPriceLookup {
  id: string
  company_id: string
  soffice_id: string
  material_id: string
  varian_id: string | null
  /** Standard regional list price for one `sales_uom` bundle of `per` base units. */
  price_regular: number
  /** Harga Jual Apotek (pharmacy sell price), when published. */
  price_hja: number | null
  /** Harga Eceran Tertinggi (max retail price), when published. */
  price_het: number | null
  /** Number of base units contained in one `sales_uom` bundle the prices apply to. */
  per: number
  /** UOM tier the prices are quoted against (e.g. Box, Strip). */
  sales_uom: string
  valid_from: string
  valid_to: string
  created_at: string
}

/** A single batch-level ATP stock record — mirrors one row of `GET /materials/:id/stock`. */
export interface MaterialStockLookup {
  id: string
  company_id: string
  soffice_id: string
  material_id: string
  varian_id: string | null
  /** ERP batch/lot identifier. */
  batch: string
  /** Shelf Life Expiration Date (YYYY-MM-DD); `null` when not tracked for the batch. */
  sled: string | null
  /** Unrestricted available-to-promise quantity for the batch. */
  qty_available: number
  /** Quantity already committed/allocated to open orders. */
  qty_allocated: number
  stock_value: number | null
  uom: string
  last_synced_at: string | null
}
