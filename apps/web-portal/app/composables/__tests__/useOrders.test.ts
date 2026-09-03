import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useOrders,
  type OrderDetailEnvelope,
  type OrderDetailResponse,
  type OrderListResponse,
  type OrderPdfUrlResponse,
  type OrderResponse
} from '../useOrders'

/** Build a single order header fixture, overriding fields per test. */
function makeOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    id: 'o1',
    company_id: 'c1',
    soffice_id: 's1',
    user_id: 'u1',
    customer_id: 'cust1',
    doctor_customer_id: null,
    visit_id: null,
    order_number: 'ORD-20240305-0001',
    erp_quotation_number: null,
    order_date: '2024-03-05',
    subtotal_amount: 100000,
    total_discount_amount: 0,
    tax_rate: 11,
    tax_amount: 11000,
    grand_total: 111000,
    order_status: 'DRAFT',
    erp_sync_timestamp: null,
    pdf_quotation_s3_key: null,
    created_at: '2024-03-05T00:00:00Z',
    updated_at: '2024-03-05T00:00:00Z',
    ...overrides
  }
}

/** Build a paginated order list envelope. */
function makeListEnvelope(row: OrderResponse = makeOrder()): OrderListResponse {
  return { data: [row], meta: { page: 1, limit: 20, total: 1 } }
}

/** Build an order detail envelope with one line item. */
function makeDetailEnvelope(overrides: Partial<OrderDetailResponse> = {}): OrderDetailEnvelope {
  return {
    data: {
      ...makeOrder(),
      items: [
        {
          id: 'oi1',
          order_id: 'o1',
          material_id: 'mat1',
          qty: 5,
          uom: 'BOX',
          unit_price: 20000,
          discount_percentage: 0,
          discount_amount: 0,
          subtotal: 100000,
          promotion_id: null,
          is_free_goods: false,
          created_at: '2024-03-05T00:00:00Z'
        }
      ],
      ...overrides
    }
  }
}

/** Build a pre-signed PDF URL envelope. */
function makePdfEnvelope(): OrderPdfUrlResponse {
  return { data: { id: 'o1', pdf_url: 'https://s3.example/quotation.pdf?sig=abc', expires_in: 3600 } }
}

/** API client stub with independently observable verbs. */
function makeApiClient(): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListEnvelope())
  const post = vi.fn(async () => makeDetailEnvelope())
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: post as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
  return { client, get, post }
}

/** A client whose every verb rejects with the given error, for error-path tests. */
function makeFailingApiClient(err: unknown): ApiClientApi {
  const reject = vi.fn(async () => {
    throw err
  })
  return {
    get: reject as unknown as ApiClientApi['get'],
    post: reject as unknown as ApiClientApi['post'],
    put: reject as unknown as ApiClientApi['put'],
    patch: reject as unknown as ApiClientApi['patch'],
    delete: reject as unknown as ApiClientApi['delete']
  }
}

describe('useOrders', () => {
  it('lists orders with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const api = useOrders({ apiClient: client })

    const result = await api.listOrders({
      page: 2,
      limit: 20,
      status: 'SUBMITTED',
      date_from: '2024-03-01',
      date_to: '2024-03-31',
      customer_id: 'cust1'
    })

    expect(get).toHaveBeenCalledWith('/orders', {
      query: {
        page: 2,
        limit: 20,
        status: 'SUBMITTED',
        date_from: '2024-03-01',
        date_to: '2024-03-31',
        customer_id: 'cust1'
      }
    })
    expect(result.data[0]?.order_number).toBe('ORD-20240305-0001')
    expect(api.error.value).toBeNull()
  })

  it('lists orders with no filters as an empty query', async () => {
    const { client, get } = makeApiClient()
    const api = useOrders({ apiClient: client })

    await api.listOrders()

    expect(get).toHaveBeenCalledWith('/orders', { query: {} })
  })

  it('fetches a single order detail via GET to /orders/:id', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce(makeDetailEnvelope())
    const api = useOrders({ apiClient: client })

    const result = await api.getOrder('o1')

    expect(get).toHaveBeenCalledWith('/orders/o1')
    expect(result.data.items).toHaveLength(1)
    expect(result.data.items[0]?.uom).toBe('BOX')
  })

  it('submits (approves) an order via POST to /orders/:id/submit', async () => {
    const { client, post } = makeApiClient()
    post.mockResolvedValueOnce(makeDetailEnvelope({ order_status: 'SUBMITTED' }))
    const api = useOrders({ apiClient: client })

    const result = await api.submitOrder('o1')

    expect(post).toHaveBeenCalledWith('/orders/o1/submit')
    expect(result.data.order_status).toBe('SUBMITTED')
  })

  it('generates a PDF quotation via POST to /orders/:id/pdf', async () => {
    const { client, post } = makeApiClient()
    post.mockResolvedValueOnce(makePdfEnvelope())
    const api = useOrders({ apiClient: client })

    const result = await api.generatePdf('o1')

    expect(post).toHaveBeenCalledWith('/orders/o1/pdf')
    expect(result.data.pdf_url).toContain('quotation.pdf')
  })

  it('fetches an existing PDF url via GET to /orders/:id/pdf', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce(makePdfEnvelope())
    const api = useOrders({ apiClient: client })

    const result = await api.getPdfUrl('o1')

    expect(get).toHaveBeenCalledWith('/orders/o1/pdf')
    expect(result.data.expires_in).toBe(3600)
  })

  it('toggles isLoading around a successful request and clears error', async () => {
    const { client } = makeApiClient()
    const api = useOrders({ apiClient: client })

    const promise = api.listOrders()
    expect(api.isLoading.value).toBe(true)
    await promise

    expect(api.isLoading.value).toBe(false)
    expect(api.error.value).toBeNull()
  })

  it('captures and rethrows a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'FORBIDDEN', message: 'no access' }, 403)
    const api = useOrders({ apiClient: makeFailingApiClient(apiError) })

    await expect(api.getOrder('o1')).rejects.toBe(apiError)
    expect(api.error.value).toBe(apiError)
    expect(api.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a REQUEST_FAILED ApiError', async () => {
    const api = useOrders({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(api.submitOrder('o1')).rejects.toBeInstanceOf(ApiError)
    expect(api.error.value?.code).toBe('REQUEST_FAILED')
  })
})
