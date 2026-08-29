import { eq, and, sql } from 'drizzle-orm'

import type { Transaction } from './index'
import { masterCustomer, doctorOutletAssignments } from './schema/customer'

/** Source from which geofence coordinates were resolved. */
export type GeofenceResolvedFrom =
  | 'outlet_direct'
  | 'outlet_context'
  | 'primary_practice'
  | 'first_assignment'
  | 'doctor_own_location'

/** Result of geofence coordinate resolution. */
export interface GeofenceTarget {
  latitude: number
  longitude: number
  resolved_from: GeofenceResolvedFrom
}

/** Structured error for geofence resolution failures. */
export class GeofenceResolutionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

/**
 * Resolves the geofence target coordinates for a visit.
 *
 * For OUTLET customers: uses the outlet's own location_geom.
 * For DOCTOR customers: resolves coordinates via outlet context, primary practice,
 * first active assignment, or the doctor's own location (in that priority order).
 */
export async function resolveGeofenceTarget(
  tx: Transaction,
  customerId: string,
  outletId?: string | null
): Promise<GeofenceTarget> {
  const customer = await fetchCustomerGeoInfo(tx, customerId)

  if (!customer) {
    throw new GeofenceResolutionError(
      'CUSTOMER_NOT_FOUND',
      `Customer '${customerId}' not found`,
      404
    )
  }

  if (customer.customerType === 'OUTLET') {
    return resolveOutletGeofence(customer)
  }

  return resolveDoctorGeofence(tx, customerId, customer, outletId)
}

// --- Internal Types ---

interface CustomerGeoInfo {
  id: string
  customerType: string
  latitude: number | null
  longitude: number | null
}

// --- Internal Helpers ---

async function fetchCustomerGeoInfo(
  tx: Transaction,
  customerId: string
): Promise<CustomerGeoInfo | null> {
  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`

  const [row] = await tx
    .select({
      id: masterCustomer.id,
      customerType: masterCustomer.customerType,
      latitude: latCol,
      longitude: lngCol,
    })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.id, customerId),
        eq(masterCustomer.isDeleted, false)
      )
    )

  return row ?? null
}

function resolveOutletGeofence(customer: CustomerGeoInfo): GeofenceTarget {
  if (customer.latitude == null || customer.longitude == null) {
    throw new GeofenceResolutionError(
      'OUTLET_NO_COORDINATES',
      `Outlet '${customer.id}' has no location coordinates`,
      422
    )
  }

  return {
    latitude: customer.latitude,
    longitude: customer.longitude,
    resolved_from: 'outlet_direct',
  }
}

async function resolveDoctorGeofence(
  tx: Transaction,
  doctorCustomerId: string,
  doctor: CustomerGeoInfo,
  outletId?: string | null
): Promise<GeofenceTarget> {
  if (outletId) {
    return resolveFromOutletContext(tx, outletId)
  }

  const assignmentTarget = await resolveFromAssignments(tx, doctorCustomerId)
  if (assignmentTarget) {
    return assignmentTarget
  }

  if (doctor.latitude != null && doctor.longitude != null) {
    return {
      latitude: doctor.latitude,
      longitude: doctor.longitude,
      resolved_from: 'doctor_own_location',
    }
  }

  throw new GeofenceResolutionError(
    'DOCTOR_NO_GEOFENCE_TARGET',
    `Cannot resolve geofence coordinates for doctor '${doctorCustomerId}': no outlet assignment or own location found`,
    422
  )
}

async function resolveFromOutletContext(
  tx: Transaction,
  outletId: string
): Promise<GeofenceTarget> {
  const outlet = await fetchCustomerGeoInfo(tx, outletId)

  if (!outlet) {
    throw new GeofenceResolutionError(
      'OUTLET_CONTEXT_NOT_FOUND',
      `Outlet context '${outletId}' not found`,
      404
    )
  }

  if (outlet.latitude == null || outlet.longitude == null) {
    throw new GeofenceResolutionError(
      'OUTLET_CONTEXT_NO_COORDINATES',
      `Outlet context '${outletId}' has no location coordinates`,
      422
    )
  }

  return {
    latitude: outlet.latitude,
    longitude: outlet.longitude,
    resolved_from: 'outlet_context',
  }
}

async function resolveFromAssignments(
  tx: Transaction,
  doctorCustomerId: string
): Promise<GeofenceTarget | null> {
  const latCol = sql<number | null>`ST_Y(outlet.location_geom)::float`
  const lngCol = sql<number | null>`ST_X(outlet.location_geom)::float`

  const rows = await tx
    .select({
      isPrimary: doctorOutletAssignments.isPrimaryPractice,
      latitude: latCol,
      longitude: lngCol,
    })
    .from(doctorOutletAssignments)
    .innerJoin(
      sql`master_customer AS outlet`,
      sql`outlet.id = ${doctorOutletAssignments.outletCustomerId} AND outlet.is_deleted = false`
    )
    .where(
      and(
        eq(doctorOutletAssignments.doctorCustomerId, doctorCustomerId),
        eq(doctorOutletAssignments.isDeleted, false),
        eq(doctorOutletAssignments.isActive, true)
      )
    )
    .orderBy(
      sql`${doctorOutletAssignments.isPrimaryPractice} DESC`,
      doctorOutletAssignments.createdAt
    )

  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue

    const resolvedFrom: GeofenceResolvedFrom = row.isPrimary
      ? 'primary_practice'
      : 'first_assignment'

    return { latitude: row.latitude, longitude: row.longitude, resolved_from: resolvedFrom }
  }

  return null
}
