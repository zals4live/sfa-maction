import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { OrderStatus, UserRole } from '@maction/types'
import type { Order } from '@maction/types'
import type {
  ApiClientApi,
  GetOptions,
  MutationOptions,
  QueuedMutationResult
} from '../../composables/useApiClient'
import { useAuthStore, type AuthTokenClaims } from '../useAuthStore'
import {
  CART_STORAGE_KEY,
  useCartStore,
  type CartItemInput,
  type CartTarget
} from '../useCartStore'

/** Base64URL-encode a UTF-8 string (test-side JWT builder). */
function base64Url(input: string): string {
  const base64 = Buffer.from(input, 'utf-8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build a valid JWT carrying the given claims (defaults to a SALESMAN). */
function makeToken(claims: Partial<AuthTokenClaims> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const payload: AuthTokenClaims = {
    user_id: 'user-1',
    company_id: 'company-a',
    soffice_id: 'soffice-1',
    role_label: UserRole.SALESMAN,
    lini_ids: ['lini-1'],
    iat: nowSec,
    exp: nowSec + 3600,
    ...claims
  }
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.sig`
}

/** In-memory localStorage shim so the stores can persist state. */
function installStorage(): { store: Map<string, string>, restore: () => void } {
  const store = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k)
    }
  })
  return {
    store,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
}

/** A fully-populated order returned by the backend on a successful online submit. */
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    company_id: 'company-a',
    user_id: 'user-1',
    soffice_id: 'soffice-1',
    customer_id: 'cust-1',
    doctor_customer_id: null,
    visit_id: null,
    order_number: 'SO-0001',
    order_status: OrderStatus.DRAFT,
    subtotal: 200,
    total_discount: 20,
    tax_rate: 0.11,
    tax_amount: 19.8,
    grand_total: 199.8,
    pdf_quotation_s3_key: null,
    erp_quotation_id: null,
    idempotency_key: 'idem-1',
    submitted_at: null,
    synced_at: null,
    created_at: '2024-01-15T08:00:00.000Z',
    updated_at: '2024-01-15T08:00:00.000Z',
    ...overrides
  }
}

const TARGET: CartTarget = {
  customer_id: 'cust-1',
  doctor_customer_id: null,
  visit_id: 'visit-1',
  soffice_id: 'soffice-1'
}

const ITEM_A: CartItemInput = {
  material_id: 'mat-a',
  material_name: 'Paracetamol 500mg',
  qty: 2,
  uom: 'BOX',
  base_qty: 20,
  price_per_base_uom: 5,
  discount_amount: 10,
  promotion_id: null
}

const ITEM_B: CartItemInput = {
  material_id: 'mat-b',
  material_name: 'Amoxicillin 500mg',
  qty: 1,
  uom: 'STRIP',
  base_qty: 10,
  price_per_base_uom: 8
}

/** A stubbed API client that records mutation calls and returns queued/online results. */
interface MockApi extends ApiClientApi {
  getMock: ReturnType<typeof vi.fn>
  postMock: ReturnType<typeof vi.fn>
}

/** Build a mock ApiClientApi. `postResult` drives the submit response. */
function makeApi(config: { postResult?: Order | QueuedMutationResult } = {}): MockApi {
  const getMock = vi.fn(async (_path: string, _options?: GetOptions<unknown>) => undefined)
  const postMock = vi.fn(async (_path: string, _options: MutationOptions) => config.postResult)
  const connectivity = { value: 'ONLINE' as const }
  return {
    connectivity: connectivity as unknown as ApiClientApi['connectivity'],
    get: getMock as unknown as ApiClientApi['get'],
    post: postMock as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete'],
    getMock,
    postMock
  }
}

/** Authenticate the auth store so the cart store can read identity. */
async function authenticate(role: UserRole = UserRole.SALESMAN): Promise<void> {
  vi.stubGlobal('$fetch', vi.fn(async () => ({ data: { token: makeToken({ role_label: role }) } })))
  const auth = useAuthStore()
  await auth.login({ email: 'a@b.com', password: 'x' })
}

describe('useCartStore', () => {
  let storage: ReturnType<typeof installStorage>

  beforeEach(() => {
    setActivePinia(createPinia())
    storage = installStorage()
  })

  afterEach(() => {
    storage.restore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('line item management + totals', () => {
    it('adds items and computes subtotal, grand total, discount, count', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })

      store.addItem(ITEM_A) // subtotal 100, discount 10, total 90
      store.addItem(ITEM_B) // subtotal 80, discount 0, total 80

      expect(store.itemCount).toBe(2)
      expect(store.isEmpty).toBe(false)
      expect(store.subtotal).toBe(180)
      expect(store.totalDiscount).toBe(10)
      expect(store.grandTotal).toBe(170)
    })

    it('replaces the line when adding the same material again', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })

      store.addItem(ITEM_A)
      store.addItem({ ...ITEM_A, base_qty: 40 }) // subtotal 200, discount 10 -> total 190

      expect(store.itemCount).toBe(1)
      expect(store.subtotal).toBe(200)
      expect(store.grandTotal).toBe(190)
    })

    it('updateItemQty recomputes the derived line money', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })
      store.addItem(ITEM_A)

      store.updateItemQty('mat-a', 3, 30) // subtotal 150, discount 10 -> total 140

      expect(store.subtotal).toBe(150)
      expect(store.grandTotal).toBe(140)
      expect(store.items[0]?.qty).toBe(3)
    })

    it('removeItem and clearItems empty the cart', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })
      store.addItem(ITEM_A)
      store.addItem(ITEM_B)

      store.removeItem('mat-a')
      expect(store.itemCount).toBe(1)

      store.clearItems()
      expect(store.isEmpty).toBe(true)
      expect(store.subtotal).toBe(0)
    })
  })

  describe('setCustomer', () => {
    it('sets the order target', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })

      store.setCustomer(TARGET)

      expect(store.target).toEqual(TARGET)
    })
  })

  describe('submitOrder', () => {
    it('submits online for a SALESMAN, returns the Order, and resets the cart', async () => {
      await authenticate()
      const store = useCartStore()
      const api = makeApi({ postResult: makeOrder() })
      store.configure({ api })
      store.setCustomer(TARGET)
      store.addItem(ITEM_A)

      const result = await store.submitOrder()

      expect(result).toEqual(makeOrder())
      const [path, options] = api.postMock.mock.calls[0] as [string, MutationOptions]
      expect(path).toBe('/orders/submit')
      expect(options.mutationType).toBe('ORDER_SUBMIT')
      expect(options.identity.user_role).toBe(UserRole.SALESMAN)
      expect(store.isEmpty).toBe(true)
      expect(store.target).toBeNull()
    })

    it('returns the queued result offline and leaves the cart intact', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi({ postResult: { queued: true, mutationId: 'mut-42' } }) })
      store.setCustomer(TARGET)
      store.addItem(ITEM_A)

      const result = await store.submitOrder()

      expect(result).toEqual({ queued: true, mutationId: 'mut-42' })
      expect(store.isEmpty).toBe(false)
      expect(store.target).toEqual(TARGET)
    })

    it('THROWS for an MR role and never calls the API (role boundary)', async () => {
      await authenticate(UserRole.MR)
      const store = useCartStore()
      const api = makeApi({ postResult: makeOrder() })
      store.configure({ api })

      // addItem is also guarded, so seed the cart via hydrate to prove submit itself blocks.
      storage.store.set(CART_STORAGE_KEY, JSON.stringify({
        items: [{
          material_id: 'mat-a', material_name: 'X', qty: 1, uom: 'BOX', base_qty: 1,
          price_per_base_uom: 1, line_subtotal: 1, discount_amount: 0, line_total: 1,
          promotion_id: null
        }],
        target: TARGET
      }))
      store.hydrate()

      await expect(store.submitOrder()).rejects.toThrow(/SALESMAN/)
      expect(api.postMock).not.toHaveBeenCalled()
    })

    it('throws when the cart is empty', async () => {
      await authenticate()
      const store = useCartStore()
      const api = makeApi({ postResult: makeOrder() })
      store.configure({ api })
      store.setCustomer(TARGET)

      await expect(store.submitOrder()).rejects.toThrow(/empty/)
      expect(api.postMock).not.toHaveBeenCalled()
    })

    it('blocks mutating actions for an MR role', async () => {
      await authenticate(UserRole.MR)
      const store = useCartStore()
      store.configure({ api: makeApi() })

      expect(() => store.addItem(ITEM_A)).toThrow(/SALESMAN/)
      expect(() => store.setCustomer(TARGET)).toThrow(/SALESMAN/)
    })
  })

  describe('persistence', () => {
    it('persists items + target and hydrate restores them', async () => {
      await authenticate()
      const writer = useCartStore()
      writer.configure({ api: makeApi() })
      writer.setCustomer(TARGET)
      writer.addItem(ITEM_A)

      // A fresh pinia + store simulates an app relaunch reading the same storage.
      setActivePinia(createPinia())
      await authenticate()
      const restored = useCartStore()
      restored.configure({ api: makeApi() })

      expect(restored.hydrate()).toBe(true)
      expect(restored.itemCount).toBe(1)
      expect(restored.target).toEqual(TARGET)
      expect(restored.grandTotal).toBe(90)
    })

    it('hydrate returns false when nothing is persisted', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })

      expect(store.hydrate()).toBe(false)
    })

    it('reset clears state and persisted storage', async () => {
      await authenticate()
      const store = useCartStore()
      store.configure({ api: makeApi() })
      store.setCustomer(TARGET)
      store.addItem(ITEM_A)
      expect(storage.store.has(CART_STORAGE_KEY)).toBe(true)

      store.reset()

      expect(store.isEmpty).toBe(true)
      expect(store.target).toBeNull()
      expect(storage.store.has(CART_STORAGE_KEY)).toBe(false)
    })
  })

  describe('identity', () => {
    it('requireIdentity throws when unauthenticated', async () => {
      const store = useCartStore()
      const api = makeApi({ postResult: makeOrder() })
      store.configure({ api })
      // No authenticated user: the SALESMAN guard trips first, so the API is never called.
      await expect(store.submitOrder()).rejects.toThrow()
      expect(api.postMock).not.toHaveBeenCalled()
    })
  })
})
