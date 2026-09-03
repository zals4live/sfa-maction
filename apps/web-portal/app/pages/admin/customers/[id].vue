<script setup lang="ts">
/**
 * `/admin/customers/:id` — Customer 360 detail view for a single Outlet or Doctor.
 *
 * Aggregates everything an admin needs about one customer on a single screen:
 *  - Identity header (name, type badge, ERP code, active status) + core profile fields.
 *  - Doctor-outlet affiliations: for a Doctor, the affiliated practice outlets sourced from
 *    `doctor_outlet_assignments` (`GET /doctors/:id/assignments`). The backend exposes
 *    affiliations only in the doctor→outlet direction, so an Outlet shows an informative
 *    empty state (no reverse endpoint).
 *  - PIC contacts from `master_pic` (embedded in the customer detail response).
 *  - A Leaflet map pinpointing the customer's stored coordinates.
 *
 * Data flows through the tenant-scoped {@link useCustomers} / {@link useDoctors} composables;
 * the map is wrapped in <ClientOnly> to avoid Leaflet SSR issues. Access is gated by the
 * `auth` middleware; the backend independently enforces tenant + role scoping. Forced Light
 * Mode is global — no `dark:` variants.
 */
import { computed } from 'vue'
import { useCustomers, type CustomerDetailResponse } from '~/composables/useCustomers'
import { useDoctors, type DoctorAssignmentResponse } from '~/composables/useDoctors'
import CustomerAffiliations from '~/components/customer/CustomerAffiliations.vue'
import CustomerPicList from '~/components/customer/CustomerPicList.vue'
import CustomerPinpointMap from '~/components/customer/CustomerPinpointMap.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

const route = useRoute()
const customers = useCustomers()
const doctors = useDoctors()

/** Route param — the customer id. Always a string for a single dynamic segment. */
const customerId = computed<string>(() => String(route.params.id))

// Fetch the customer detail (customer + PICs + doctor profile), SSR-friendly.
const {
  data: detailData,
  pending: detailPending,
  error: detailError,
  refresh
} = await useAsyncData<{ data: CustomerDetailResponse }>(
  () => `customer-detail-${customerId.value}`,
  () => customers.getCustomer(customerId.value),
  { watch: [customerId] }
)

const customer = computed<CustomerDetailResponse | null>(() => detailData.value?.data ?? null)
const isDoctor = computed<boolean>(() => customer.value?.customer_type === 'DOCTOR')

// For a Doctor, fetch practice-outlet affiliations; skip the call for other types.
const { data: assignmentData } = await useAsyncData<DoctorAssignmentResponse[]>(
  () => `customer-affiliations-${customerId.value}`,
  async () => {
    if (!isDoctor.value) return []
    const result = await doctors.listAssignments(customerId.value)
    return result.data
  },
  { watch: [customerId, isDoctor] }
)

const affiliations = computed<DoctorAssignmentResponse[]>(() => assignmentData.value ?? [])

/** Empty-state copy for the affiliations panel, tailored to the customer type. */
const affiliationsEmptyLabel = computed<string>(() =>
  isDoctor.value
    ? 'Belum ada afiliasi outlet praktik'
    : 'Afiliasi dokter dikelola dari data dokter'
)

/** Badge palette accepted by Nuxt UI components. */
type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

/** Human-readable type label + badge color per customer type. */
const TYPE_META: Record<string, { label: string, color: BadgeColor }> = {
  OUTLET: { label: 'Outlet', color: 'primary' },
  DOCTOR: { label: 'Dokter', color: 'info' },
  COMMUNITY: { label: 'Komunitas', color: 'warning' },
  EVENT: { label: 'Event', color: 'neutral' }
}

const FALLBACK_TYPE_META: { label: string, color: BadgeColor } = TYPE_META.OUTLET!

const typeMeta = computed<{ label: string, color: BadgeColor }>(
  () => TYPE_META[customer.value?.customer_type ?? 'OUTLET'] ?? FALLBACK_TYPE_META
)

useHead(() => ({
  title: customer.value
    ? `${customer.value.name} — KF Maction Admin`
    : 'Detail Pelanggan — KF Maction Admin'
}))
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Back link -->
    <div>
      <UButton
        to="/admin/customers"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        label="Kembali ke Pelanggan"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="detailError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat detail pelanggan"
      description="Detail pelanggan tidak dapat dimuat saat ini. Silakan coba lagi."
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
      v-else-if="detailPending && !customer"
      class="flex items-center gap-2 text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-5 animate-spin"
      />
      <span class="text-sm">Memuat detail pelanggan…</span>
    </div>

    <template v-else-if="customer">
      <!-- Identity header -->
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-semibold text-highlighted">
              {{ customer.name }}
            </h1>
            <UBadge
              :color="typeMeta.color"
              variant="subtle"
              size="sm"
              :label="typeMeta.label"
            />
            <UBadge
              :color="customer.is_active ? 'success' : 'neutral'"
              variant="subtle"
              size="sm"
              :label="customer.is_active ? 'Aktif' : 'Nonaktif'"
            />
          </div>
          <p class="text-sm text-muted">
            Kode ERP: {{ customer.erp_customer_code ?? '—' }}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <!-- Profile + affiliations + PICs -->
        <div class="flex flex-col gap-6 lg:col-span-2">
          <!-- Profile card -->
          <UCard>
            <template #header>
              <h2 class="text-base font-semibold text-highlighted">
                Profil
              </h2>
            </template>

            <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-muted">
                  Alamat
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ customer.address ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Kota
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ customer.city ?? '—' }}
                </dd>
              </div>
              <div v-if="customer.doctor_profile">
                <dt class="text-xs text-muted">
                  Spesialisasi
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ customer.doctor_profile.specialization ?? '—' }}
                </dd>
              </div>
              <div v-if="customer.doctor_profile">
                <dt class="text-xs text-muted">
                  No. SIP/STR
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ customer.doctor_profile.sip_str_number ?? '—' }}
                </dd>
              </div>
            </dl>
          </UCard>

          <!-- Affiliations card -->
          <UCard>
            <template #header>
              <h2 class="text-base font-semibold text-highlighted">
                {{ isDoctor ? 'Outlet Praktik' : 'Afiliasi Dokter' }}
              </h2>
            </template>
            <CustomerAffiliations
              :assignments="affiliations"
              :empty-label="affiliationsEmptyLabel"
            />
          </UCard>

          <!-- PIC contacts card -->
          <UCard>
            <template #header>
              <h2 class="text-base font-semibold text-highlighted">
                Kontak PIC
              </h2>
            </template>
            <CustomerPicList :pics="customer.pics" />
          </UCard>
        </div>

        <!-- Map pinpoint -->
        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <h2 class="text-base font-semibold text-highlighted">
              Lokasi
            </h2>
          </template>
          <ClientOnly>
            <CustomerPinpointMap
              :name="customer.name"
              :latitude="customer.latitude"
              :longitude="customer.longitude"
            />
            <template #fallback>
              <div class="flex h-80 items-center justify-center text-muted">
                <UIcon
                  name="i-lucide-loader-circle"
                  class="size-6 animate-spin"
                />
              </div>
            </template>
          </ClientOnly>
        </UCard>
      </div>
    </template>
  </div>
</template>
