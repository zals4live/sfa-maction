<script setup lang="ts">
/**
 * `FraudIncidentTable` — the fraud telemetry register for the reporting center.
 *
 * Presentation-only: it renders one row per incident from `GET /reports/fraud-incidents`,
 * surfacing the fraud type, severity, claimed coordinates, calculated speed, and the
 * action the anti-spoofing pipeline took (soft rejection, logged, …). Filtering and
 * pagination live in the page; this component only shapes the returned rows.
 *
 * Fraud type and severity are rendered as color-coded badges so an admin can triage the
 * register at a glance. Forced Light Mode is global — no dark-mode classes here.
 */
import { h } from 'vue'
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { FraudIncidentRow, FraudType } from '~/composables/useReporting'

const props = withDefaults(
  defineProps<{
    /** Rows resolved from `/reports/fraud-incidents`. */
    rows: FraudIncidentRow[]
    /** Whether the parent fetch is in flight (drives the table skeleton). */
    loading?: boolean
  }>(),
  {
    loading: false
  }
)

/** Human-readable labels for each fraud telemetry type. */
const FRAUD_LABELS: Record<FraudType, string> = {
  MOCK_LOCATION: 'Lokasi Palsu',
  VELOCITY_ANOMALY: 'Anomali Kecepatan',
  ACCURACY_EXCESS: 'Akurasi Berlebih',
  CLOCK_DRIFT: 'Drift Waktu'
}

/** Format an ISO/date string as a compact Indonesian date-time. */
function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Map a severity string to a semantic badge color; defaults to neutral. */
function severityColor(severity: string): BadgeProps['color'] {
  const normalized = severity.toUpperCase()
  if (normalized === 'HIGH' || normalized === 'CRITICAL') return 'error'
  if (normalized === 'MEDIUM') return 'warning'
  if (normalized === 'LOW') return 'neutral'
  return 'neutral'
}

const columns: TableColumn<FraudIncidentRow>[] = [
  {
    accessorKey: 'created_at',
    header: 'Waktu',
    cell: ({ row }) => h('span', { class: 'text-xs text-toned' }, formatDateTime(row.original.created_at))
  },
  {
    accessorKey: 'fraud_type',
    header: 'Jenis',
    cell: ({ row }) =>
      h(
        resolveComponent('UBadge'),
        { color: 'error', variant: 'subtle', size: 'sm' },
        () => FRAUD_LABELS[row.original.fraud_type] ?? row.original.fraud_type
      )
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: ({ row }) =>
      h(resolveComponent('UBadge'), {
        color: severityColor(row.original.severity),
        variant: 'subtle',
        size: 'sm',
        label: row.original.severity
      })
  },
  {
    id: 'coordinates',
    header: 'Koordinat Klaim',
    cell: ({ row }) => {
      const { claimed_lat, claimed_lng } = row.original
      const text = claimed_lat != null && claimed_lng != null
        ? `${claimed_lat.toFixed(5)}, ${claimed_lng.toFixed(5)}`
        : '—'
      return h('span', { class: 'font-mono text-xs text-muted' }, text)
    }
  },
  {
    accessorKey: 'calculated_speed_kmh',
    header: () => h('div', { class: 'text-right' }, 'Kecepatan'),
    cell: ({ row }) => {
      const speed = row.original.calculated_speed_kmh
      const text = speed != null ? `${speed.toFixed(1)} km/j` : '—'
      return h('div', { class: 'text-right tabular-nums' }, text)
    }
  },
  {
    accessorKey: 'action_taken',
    header: 'Tindakan',
    cell: ({ row }) => h('span', { class: 'text-xs text-muted' }, row.original.action_taken)
  }
]
</script>

<template>
  <UTable
    :data="props.rows"
    :columns="columns"
    :loading="props.loading"
    loading-color="primary"
    empty="Tidak ada insiden fraud untuk filter ini."
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
