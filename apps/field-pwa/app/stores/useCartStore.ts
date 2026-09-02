/**
 * `useCartStore` — SALESMAN-only order cart state with offline persistence.
 *
 * The single source of truth for the in-progress order a SALESMAN is building during a
 * visit (or by-phone). Order-taking is a SALESMAN-EXCLUSIVE capability: the MR role is
 * strictly forbidden from creating carts or submitting orders. Every mutating action is
 * guarded so that a non-SALESMAN user causes a clear error and never enqueues an
 * `ORDER_SUBMIT` mutation — mirroring the backend `403 Forbidden` enforcement and the
 * `useRoleGuard.canTakeOrder` UI gate. It owns:
 *  - The cart line items ({@link CartStoreApi.items}) — a pre-submit draft. Each line is a
 *    {@link CartLineItem}, modelled on the persisted `OrderItem` shape from `@maction/types`
 *    but defined locally because the cart carries only the fields captured on-device before
 *    submission (no `id`/`order_id`/`created_at`, which the backend assigns).
 *  - The order target ({@link CartStoreApi.target}) — `customer_id`, optional
 *    `doctor_customer_id`, optional `visit_id`, and `soffice_id` for the order being built.
 *  - Client-side money totals ({@link CartStoreApi.subtotal}, {@link CartStoreApi.totalDiscount},
 *    {@link CartStoreApi.grandTotal}) derived from line items. Tax (PPN) is deliberately NOT
 *    computed here — the backend order service owns tax calculation; the client only rolls
 *    up subtotal/discount/grand-total so the SALESMAN sees a running estimate.
 *  - Offline persistence: the draft is written to `localStorage` (SSR-guarded via
 *    {@link hasStorage}) under {@link CART_STORAGE_KEY} so a partially-built cart survives a
 *    reload or a background/foreground cycle. {@link CartStoreApi.hydrate} restores it on
 *    launch; {@link CartStoreApi.reset} clears both in-memory and persisted state. There is
 *    no cart Dexie table — only `outbox_mutations` — so localStorage is the right store for
 *    this transient draft.
 *  - Submission: {@link CartStoreApi.submitOrder} flows through {@link useApiClient.post},
 *    which performs it online (returning the created {@link Order}) or queues it to the
 *    offline outbox as an `ORDER_SUBMIT` mutation (returning a {@link QueuedMutationResult}).
 *
 * Identity (`company_id`, `user_id`, `user_role`) is read from {@link useAuthStore} via
 * {@link requireIdentity} and forwarded to the mutation. The API client is injectable via
 * {@link CartStoreApi.configure} so tests can drive the store with a mock — mirroring the
 * transport-injection pattern in `useAttendanceStore`.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { defineStore } from 'pinia'
import { UserRole } from '@maction/types'
import type { MutationType, Order, OrderItem } from '@maction/types'
import {
  useApiClient,
  type ApiClientApi,
  type QueuedMutationResult
} from '../composables/useApiClient'
import { useAuthStore } from './useAuthStore'

/** localStorage key holding the persisted in-progress cart draft. */
export const CART_STORAGE_KEY = 'maction_cart_state'

/** Mutation type recorded in the offline outbox when an order is queued. */
const ORDER_SUBMIT_MUTATION: MutationType = 'ORDER_SUBMIT'

/**
 * A single cart line item — a pre-submit draft of an `OrderItem`.
 *
 * Defined locally (rather than reusing `@maction/types`' {@link OrderItem}) because the cart
 * holds only the fields captured on-device before submission; the backend assigns `id`,
 * `order_id`, `company_id`, and `created_at` when the order is persisted.
 */
export interface CartLineItem {
  material_id: string
  material_name: string
  qty: number
  uom: string
  base_qty: number
  price_per_base_uom: number
  line_subtotal: number
  discount_amount: number
  line_total: number
  promotion_id: string | null
}

/** The customer/visit context the order is being built against. */
export interface CartTarget {
  customer_id: string
  doctor_customer_id: string | null
  visit_id: string | null
  soffice_id: string
}

/** Fields required to add or update a cart line (totals are derived, not supplied). */
export interface CartItemInput {
  material_id: string
  material_name: string
  qty: number
  uom: string
  base_qty: number
  price_per_base_uom: number
  discount_amount?: number
  promotion_id?: string | null
}

/** Options for {@link useCartStore}; all optional so runtime and tests can diverge. */
export interface CartStoreOptions {
  /** Override the API client (tests inject a mock; runtime falls back to {@link useApiClient}). */
  api?: ApiClientApi
}

/** Persisted snapshot of the cart draft written to localStorage. */
interface PersistedCart {
  items: CartLineItem[]
  target: CartTarget | null
}

/** Narrow a submit result to the queued (offline) branch. */
function isQueued(result: Order | QueuedMutationResult): result is QueuedMutationResult {
  return (result as QueuedMutationResult).queued === true
}

/** Whether client-side storage is reachable (guards SSR and locked-down runtimes). */
function hasStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

/** Read the capturing user's identity from the auth store, or throw if unauthenticated. */
function requireIdentity(auth: ReturnType<typeof useAuthStore>): {
  company_id: string
  user_id: string
  user_role: UserRole
} {
  const companyId = auth.companyId
  const userId = auth.userId
  const role = auth.role
  if (!companyId || !userId || !role) {
    throw new Error('Cannot build an order: no authenticated field user in context.')
  }
  return { company_id: companyId, user_id: userId, user_role: role }
}

/** Compute the per-line money fields from the raw input (subtotal, then total after discount). */
function buildLineItem(input: CartItemInput): CartLineItem {
  const discount = input.discount_amount ?? 0
  const lineSubtotal = input.base_qty * input.price_per_base_uom
  return {
    material_id: input.material_id,
    material_name: input.material_name,
    qty: input.qty,
    uom: input.uom,
    base_qty: input.base_qty,
    price_per_base_uom: input.price_per_base_uom,
    line_subtotal: lineSubtotal,
    discount_amount: discount,
    line_total: lineSubtotal - discount,
    promotion_id: input.promotion_id ?? null
  }
}

/** Parse a persisted snapshot from storage, tolerating malformed/absent data. */
function parsePersistedCart(raw: string | null): PersistedCart | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCart>
    if (!Array.isArray(parsed.items)) return null
    return { items: parsed.items, target: parsed.target ?? null }
  } catch {
    return null
  }
}

export const useCartStore = defineStore('cart', () => {
  const auth = useAuthStore()

  // The API client is bound once per store instance. Tests override it via `configure`.
  let api: ApiClientApi = useApiClient()

  const items: Ref<CartLineItem[]> = ref([])
  const target: Ref<CartTarget | null> = ref(null)
  const submitting: Ref<boolean> = ref(false)
  const error: Ref<string | null> = ref(null)

  /** Running subtotal across all lines (pre-discount, pre-tax). */
  const subtotal: ComputedRef<number> = computed(() =>
    items.value.reduce((sum, item) => sum + item.line_subtotal, 0)
  )

  /** Total discount across all lines. */
  const totalDiscount: ComputedRef<number> = computed(() =>
    items.value.reduce((sum, item) => sum + item.discount_amount, 0)
  )

  /** Grand total (subtotal minus discount); tax is applied server-side, not here. */
  const grandTotal: ComputedRef<number> = computed(() =>
    items.value.reduce((sum, item) => sum + item.line_total, 0)
  )

  /** Number of distinct line items in the cart. */
  const itemCount: ComputedRef<number> = computed(() => items.value.length)

  /** Whether the cart currently holds no line items. */
  const isEmpty: ComputedRef<boolean> = computed(() => items.value.length === 0)

  /** Persist the current draft to storage; no-op under SSR. */
  function persist(): void {
    if (!hasStorage()) return
    const snapshot: PersistedCart = { items: items.value, target: target.value }
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(snapshot))
  }

  /** Clear the persisted draft from storage; no-op under SSR. */
  function clearPersisted(): void {
    if (!hasStorage()) return
    localStorage.removeItem(CART_STORAGE_KEY)
  }

  /** Guard: only a SALESMAN may build or submit orders. Throws for every other role. */
  function assertSalesman(): void {
    if (!auth.isSalesman) {
      throw new Error('Only SALESMAN may take orders.')
    }
  }

  /** Add a line item (or replace an existing line for the same material), then persist. */
  function addItem(input: CartItemInput): void {
    assertSalesman()
    const line = buildLineItem(input)
    const existing = items.value.findIndex(item => item.material_id === line.material_id)
    if (existing >= 0) items.value.splice(existing, 1, line)
    else items.value.push(line)
    persist()
  }

  /** Recompute a line's derived money fields for a new quantity, preserving pricing. */
  function updateItemQty(materialId: string, qty: number, baseQty: number): void {
    assertSalesman()
    const item = items.value.find(entry => entry.material_id === materialId)
    if (!item) return
    items.value.splice(items.value.indexOf(item), 1, buildLineItem({
      ...item,
      qty,
      base_qty: baseQty
    }))
    persist()
  }

  /** Remove a line item by material id, then persist. */
  function removeItem(materialId: string): void {
    assertSalesman()
    items.value = items.value.filter(item => item.material_id !== materialId)
    persist()
  }

  /** Empty all line items (keeps the target), then persist. */
  function clearItems(): void {
    assertSalesman()
    items.value = []
    persist()
  }

  /** Set the customer/visit context for the order being built, then persist. */
  function setCustomer(nextTarget: CartTarget): void {
    assertSalesman()
    target.value = nextTarget
    persist()
  }

  /** Build the request body submitted to the order endpoint from cart + identity. */
  function buildOrderBody(): Record<string, unknown> {
    if (!target.value) {
      throw new Error('Cannot submit an order without a target customer.')
    }
    return {
      customer_id: target.value.customer_id,
      doctor_customer_id: target.value.doctor_customer_id,
      visit_id: target.value.visit_id,
      soffice_id: target.value.soffice_id,
      subtotal: subtotal.value,
      total_discount: totalDiscount.value,
      grand_total: grandTotal.value,
      items: items.value
    }
  }

  /**
   * Submit the cart as an order. SALESMAN-only and non-empty are enforced BEFORE any payload
   * is built or the API is touched, so MR never reaches `api.post`. Online: resets the cart
   * and returns the created {@link Order}. Offline (queued): leaves the cart intact so the
   * SALESMAN can still review it, and returns the {@link QueuedMutationResult}.
   */
  async function submitOrder(): Promise<Order | QueuedMutationResult> {
    assertSalesman()
    if (isEmpty.value) {
      throw new Error('Cannot submit an empty cart.')
    }
    error.value = null
    submitting.value = true
    try {
      const identity = requireIdentity(auth)
      const body = buildOrderBody()
      const result = await api.post<Order>('/orders/submit', {
        identity,
        mutationType: ORDER_SUBMIT_MUTATION,
        body
      })
      if (isQueued(result)) return result
      reset()
      return result
    } finally {
      submitting.value = false
    }
  }

  /** Restore a persisted cart draft from storage on launch; returns whether one was found. */
  function hydrate(): boolean {
    const persisted = parsePersistedCart(hasStorage() ? localStorage.getItem(CART_STORAGE_KEY) : null)
    if (!persisted) return false
    items.value = persisted.items
    target.value = persisted.target
    return true
  }

  /** Clear all cart state and drop the persisted draft (logout, tenant switch, post-submit). */
  function reset(): void {
    items.value = []
    target.value = null
    submitting.value = false
    error.value = null
    clearPersisted()
  }

  /** Test/config seam: replace the injected API client. */
  function configure(options: CartStoreOptions): void {
    if (options.api) api = options.api
  }

  return {
    items,
    target,
    submitting,
    error,
    subtotal,
    totalDiscount,
    grandTotal,
    itemCount,
    isEmpty,
    addItem,
    updateItemQty,
    removeItem,
    clearItems,
    setCustomer,
    submitOrder,
    hydrate,
    reset,
    configure
  }
})

// Re-exported for reference: the persisted order-item shape the cart draft mirrors.
export type { OrderItem }
