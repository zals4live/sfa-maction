/**
 * `useOrders` — order review + approval reads/actions for the Web Portal (admin, SSR).
 *
 * The single abstraction the `/admin/orders` pages use to drive the backend order module
 * (see services/api-server/src/modules/order/routes.ts), mounted under the `/orders` prefix
 * and gated by tenantGuard + role checks. Only Salesman-authored orders exist in the system
 * (order-taking is a `SALESMAN`-exclusive surface; `MR` receives `403` on all write routes),
 * so every list this composable returns is implicitly "Salesman orders only".
 *
 * Endpoints consumed:
 *  - `GET  /orders`            — paginated, filterable order list (`{ data, meta }`), readable
 *    by SALESMAN + admin roles (ORDER_READERS); MR is excluded server-side.
 *  - `GET  /orders/:id`        — single order header with nested line items.
 *  - `POST /orders/:id/submit` — advance a DRAFT order to SUBMITTED (queues ERP sync). The
 *    portal's "approve / submit-to-ERP" action for a pending order.
 *  - `POST /orders/:id/pdf`    — (re)generate the branded PDF quotation, returns a download URL.
 *  - `GET  /orders/:id/pdf`    — pre-signed download URL for an already-generated PDF.
 *
 * It mirrors the shape and testing pattern of {@link useCallPlans} / {@link useCustomers}: no
 * cache-aside layer (order state is volatile and staleness would mislead approval decisions),
 * one typed method per endpoint, and reactive `isLoading` / `error` refs so pages render
 * spinners and error banners without a try/catch at every call site. The API client is
 * injectable (tests supply a mock), runtime falls back to {@link useApiClient}, and nothing
 * throws outside a Nuxt runtime.
 *
 * NOTE on "reject": the backend exposes no reject-mutation endpoint. Rejection of an order is
 * handled downstream by the ERP (`REJECTED_ERP` status flows back via ERP sync), so the portal
 * surfaces that status read-only rather than offering a reject write action.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Order lifecycle status — mirrors PostgreSQL order_status_enum and @maction/types OrderStatus. */
export type OrderStatusValue
  = | 'DRAFT'
    | 'SUBMITTED'
    | 'SYNCED_ERP'
    | 'REJECTED_ERP'
    | 'CANCELLED'

// --- Query shapes (mirror services/api-server/src/modules/order/schemas.ts ListOrdersQuery) ---

/** `GET /orders` pagination + filter query params. */
export interface ListOrdersQuery {
  page?: number
  limit?: number
  /** Filter by order lifecycle status. */
  status?: OrderStatusValue
  /** Filter orders from this date (inclusive, `YYYY-MM-DD`). */
  date_from?: string
  /** Filter orders up to this date (inclusive, `YYYY-MM-DD`). */
  date_to?: string
  /** Filter by customer (uuid). */
  customer_id?: string
}

// --- Response shapes (mirror the backend response schemas) ---

/** A single order line item record. */
export interface OrderItemResponse {
  id: string
  order_id: string
  material_id: string
  qty: number
  uom: string
  unit_price: number
  discount_percentage: number
  discount_amount: number
  subtotal: number
  promotion_id: string | null
  is_free_goods: boolean
  created_at: string
}

/** A single order header record (as returned by the list endpoint). */
export interface OrderResponse {
  id: string
  company_id: string
  soffice_id: string
  user_id: string
  customer_id: string
  doctor_customer_id: string | null
  visit_id: string | null
  order_number: string
  erp_quotation_number: string | null
  order_date: string
  subtotal_amount: number
  total_discount_amount: number
  tax_rate: number
  tax_amount: number
  grand_total: number
  order_status: OrderStatusValue
  erp_sync_timestamp: string | null
  pdf_quotation_s3_key: string | null
  created_at: string
  updated_at: string
}

/** Order detail — header with nested line items. */
export interface OrderDetailResponse extends OrderResponse {
  items: OrderItemResponse[]
}

/** `GET /orders` paginated envelope. */
export interface OrderListResponse {
  data: OrderResponse[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** `GET /orders/:id` and `POST /orders/:id/submit` detail envelope. */
export interface OrderDetailEnvelope {
  data: OrderDetailResponse
}

/** `GET|POST /orders/:id/pdf` pre-signed PDF download URL envelope. */
export interface OrderPdfUrlResponse {
  data: {
    id: string
    pdf_url: string
    expires_in: number
  }
}

/** Options for {@link useOrders}; all optional so runtime and tests can diverge. */
export interface UseOrdersOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useOrders}. */
export interface UseOrdersApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Fetch a paginated, filterable list of (Salesman) orders. */
  listOrders: (query?: ListOrdersQuery) => Promise<OrderListResponse>
  /** Fetch a single order with its line items. */
  getOrder: (id: string) => Promise<OrderDetailEnvelope>
  /** Approve/submit a DRAFT order for ERP sync (DRAFT → SUBMITTED). */
  submitOrder: (id: string) => Promise<OrderDetailEnvelope>
  /** (Re)generate the branded PDF quotation and return a download URL. */
  generatePdf: (id: string) => Promise<OrderPdfUrlResponse>
  /** Fetch a pre-signed download URL for an already-generated PDF quotation. */
  getPdfUrl: (id: string) => Promise<OrderPdfUrlResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useOrders(options: UseOrdersOptions = {}): UseOrdersApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)

  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)

  /** Run a request while managing the reactive `isLoading` / `error` refs. */
  async function run<T>(op: () => Promise<T>): Promise<T> {
    isLoading.value = true
    error.value = null
    try {
      return await op()
    } catch (err) {
      const apiError = toApiError(err)
      error.value = apiError
      throw apiError
    } finally {
      isLoading.value = false
    }
  }

  function listOrders(query: ListOrdersQuery = {}): Promise<OrderListResponse> {
    return run(() => apiClient.get<OrderListResponse>('/orders', {
      query: query as Record<string, unknown>
    }))
  }

  function getOrder(id: string): Promise<OrderDetailEnvelope> {
    return run(() => apiClient.get<OrderDetailEnvelope>(`/orders/${id}`))
  }

  function submitOrder(id: string): Promise<OrderDetailEnvelope> {
    return run(() => apiClient.post<OrderDetailEnvelope>(`/orders/${id}/submit`))
  }

  function generatePdf(id: string): Promise<OrderPdfUrlResponse> {
    return run(() => apiClient.post<OrderPdfUrlResponse>(`/orders/${id}/pdf`))
  }

  function getPdfUrl(id: string): Promise<OrderPdfUrlResponse> {
    return run(() => apiClient.get<OrderPdfUrlResponse>(`/orders/${id}/pdf`))
  }

  return {
    isLoading,
    error,
    listOrders,
    getOrder,
    submitOrder,
    generatePdf,
    getPdfUrl
  }
}
