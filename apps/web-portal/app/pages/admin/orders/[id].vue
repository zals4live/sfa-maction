<script setup lang="ts">
/**
 * `/admin/orders/:id` — order review + approval detail view for a single Salesman order.
 *
 * Aggregates everything an admin needs to review and act on one order:
 *  - Identity header (order number, status badge, order date, ERP quotation number).
 *  - Line items (qty, UOM, unit price, discount, subtotal) via {@link OrderItemsTable}.
 *  - A totals panel: subtotal, total discount, PPN (tax rate + amount), and grand total.
 *  - Metadata (customer/outlet, doctor context, salesman, originating visit, ERP sync time).
 *
 * Approval actions, gated by the order's lifecycle status (`order_status_enum`):
 *  - DRAFT orders can be approved → submitted to ERP (`POST /orders/:id/submit`), which advances
 *    them to SUBMITTED and queues the outbound ERP Sales Quotation sync.
 *  - The branded PDF quotation can be (re)generated and downloaded (`POST /orders/:id/pdf`) for
 *    any order; already-generated PDFs are downloadable directly.
 *  There is no reject action — rejection flows back from the ERP as `REJECTED_ERP` (read-only).
 *
 * Data flows through the tenant-scoped {@link useOrders} composable. Access is gated by the
 * `auth` middleware (ADMIN roles); the backend independently enforces tenant + role scoping.
 * Forced Light Mode is global — no `dark:` variants.
 */
import { computed, ref } from 'vue'
import { useOrders, type OrderDetailEnvelope, type OrderDetailResponse } from '~/composables/useOrders'
import OrderStatusBadge from '~/components/order/OrderStatusBadge.vue'
import OrderItemsTable from '~/components/order/OrderItemsTable.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

const route = useRoute()
const orders = useOrders()
const toast = useToast()

/** Route param — the order id. Always a string for a single dynamic segment. */
const orderId = computed<string>(() => String(route.params.id))

// Fetch the order detail (header + line items), SSR-friendly.
const {
  data: detailData,
  pending: detailPending,
  error: detailError,
  refresh
} = await useAsyncData<OrderDetailEnvelope>(
  () => `order-detail-${orderId.value}`,
  () => orders.getOrder(orderId.value),
  { watch: [orderId] }
)

const order = computed<OrderDetailResponse | null>(() => detailData.value?.data ?? null)

/** DRAFT orders are the only ones awaiting approval/submission to ERP. */
const canApprove = computed<boolean>(() => order.value?.order_status === 'DRAFT')

// --- Approval (submit-to-ERP) flow ---
const isApproveOpen = ref<boolean>(false)
const approving = ref<boolean>(false)

/** Approve the order → submit for ERP sync, then close the dialog and refresh. */
async function onConfirmApprove(): Promise<void> {
  if (!order.value) return
  approving.value = true
  try {
    await orders.submitOrder(order.value.id)
    isApproveOpen.value = false
    toast.add({ title: 'Pesanan disetujui & diajukan ke ERP', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menyetujui pesanan', color: 'error' })
  } finally {
    approving.value = false
  }
}

// --- PDF quotation flow ---
const generatingPdf = ref<boolean>(false)

/** Generate (or refresh) the PDF quotation and open the returned pre-signed URL. */
async function onDownloadPdf(): Promise<void> {
  if (!order.value) return
  generatingPdf.value = true
  try {
    const result = await orders.generatePdf(order.value.id)
    if (import.meta.client) window.open(result.data.pdf_url, '_blank', 'noopener')
    toast.add({ title: 'Kuotasi PDF siap diunduh', color: 'success' })
  } catch {
    toast.add({ title: 'Gagal membuat kuotasi PDF', color: 'error' })
  } finally {
    generatingPdf.value = false
  }
}

/** Format a rupiah amount as a compact currency string (no fractional cents). */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value)
}

/** Format an ISO/date string as a compact Indonesian date. */
function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Format an ISO datetime string as a compact Indonesian date-time. */
function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('id-ID')
}

useHead(() => ({
  title: order.value
    ? `${order.value.order_number} — KF Maction Admin`
    : 'Detail Pesanan — KF Maction Admin'
}))
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Back link -->
    <div>
      <UButton
        to="/admin/orders"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        label="Kembali ke Pesanan"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="detailError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat detail pesanan"
      description="Detail pesanan tidak dapat dimuat saat ini. Silakan coba lagi."
    >
      <template #actions>
        <UButton
          color="error"
          variant="outline"
          size="xs"
          label="Coba Lagi"
          @click="refresh()"
        />
      </template>
    </UAlert>

    <!-- Loading skeleton -->
    <div
      v-else-if="detailPending && !order"
      class="flex items-center gap-2 text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-5 animate-spin"
      />
      <span class="text-sm">Memuat detail pesanan…</span>
    </div>

    <template v-else-if="order">
      <!-- Identity header + actions -->
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-semibold text-highlighted">
              {{ order.order_number }}
            </h1>
            <OrderStatusBadge :status="order.order_status" />
          </div>
          <p class="text-sm text-muted">
            Tanggal pesanan: {{ formatDate(order.order_date) }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            icon="i-lucide-file-down"
            color="neutral"
            variant="outline"
            label="Unduh Kuotasi PDF"
            :loading="generatingPdf"
            :disabled="generatingPdf"
            @click="onDownloadPdf"
          />
          <UButton
            v-if="canApprove"
            icon="i-lucide-check-check"
            color="primary"
            label="Setujui & Ajukan ke ERP"
            @click="isApproveOpen = true"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <!-- Line items + metadata -->
        <div class="flex flex-col gap-6 lg:col-span-2">
          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <template #header>
              <h2 class="text-base font-semibold text-highlighted">
                Item Pesanan
              </h2>
            </template>
            <OrderItemsTable :items="order.items" />
          </UCard>

          <!-- Metadata card -->
          <UCard>
            <template #header>
              <h2 class="text-base font-semibold text-highlighted">
                Informasi Pesanan
              </h2>
            </template>

            <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-muted">
                  Pelanggan / Outlet
                </dt>
                <dd class="font-mono text-xs text-highlighted">
                  {{ order.customer_id }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Konteks Dokter
                </dt>
                <dd class="font-mono text-xs text-highlighted">
                  {{ order.doctor_customer_id ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Salesman
                </dt>
                <dd class="font-mono text-xs text-highlighted">
                  {{ order.user_id }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Kunjungan Asal
                </dt>
                <dd class="font-mono text-xs text-highlighted">
                  {{ order.visit_id ?? '— (By Phone)' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  No. Kuotasi ERP
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ order.erp_quotation_number ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Waktu Sinkron ERP
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ formatDateTime(order.erp_sync_timestamp) }}
                </dd>
              </div>
            </dl>
          </UCard>
        </div>

        <!-- Totals panel -->
        <UCard>
          <template #header>
            <h2 class="text-base font-semibold text-highlighted">
              Ringkasan Total
            </h2>
          </template>

          <dl class="flex flex-col gap-3 text-sm">
            <div class="flex items-center justify-between">
              <dt class="text-muted">
                Subtotal
              </dt>
              <dd class="tabular-nums text-toned">
                {{ formatCurrency(order.subtotal_amount) }}
              </dd>
            </div>
            <div class="flex items-center justify-between">
              <dt class="text-muted">
                Total Diskon
              </dt>
              <dd class="tabular-nums text-toned">
                {{ order.total_discount_amount > 0 ? '−' : '' }}{{ formatCurrency(order.total_discount_amount) }}
              </dd>
            </div>
            <div class="flex items-center justify-between">
              <dt class="text-muted">
                PPN ({{ order.tax_rate }}%)
              </dt>
              <dd class="tabular-nums text-toned">
                {{ formatCurrency(order.tax_amount) }}
              </dd>
            </div>
            <div class="mt-1 flex items-center justify-between border-t border-default pt-3">
              <dt class="font-semibold text-highlighted">
                Grand Total
              </dt>
              <dd class="text-base font-semibold tabular-nums text-highlighted">
                {{ formatCurrency(order.grand_total) }}
              </dd>
            </div>
          </dl>
        </UCard>
      </div>
    </template>

    <!-- Approve confirmation modal -->
    <UModal
      v-model:open="isApproveOpen"
      title="Setujui Pesanan"
      :description="order
        ? `Setujui '${order.order_number}' dan ajukan ke ERP? Status akan menjadi Diajukan dan sinkronisasi ERP dimulai.`
        : ''"
      :dismissible="!approving"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Batal"
            :disabled="approving"
            @click="isApproveOpen = false"
          />
          <UButton
            color="primary"
            label="Setujui & Ajukan"
            :loading="approving"
            @click="onConfirmApprove"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
