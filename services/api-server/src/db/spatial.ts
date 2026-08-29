import { sql } from 'drizzle-orm'

import type { Transaction } from './index'

/** Result of a PostGIS distance calculation against a soffice location. */
export interface SofficeDistanceResult {
  distance_meters: number | null
  geofence_radius_meters: number
}

/**
 * Calculate the PostGIS distance (in meters) between submitted coordinates
 * and a sales office's stored location geometry.
 *
 * Uses ST_DistanceSphere for accurate geodesic distance on SRID 4326 points.
 * Also retrieves the company's configured geofence radius for comparison.
 *
 * @param tx - Active Drizzle transaction (RLS context must already be set)
 * @param coords - Submitted GPS coordinates
 * @param sofficeId - Target sales office UUID
 * @param companyId - Tenant company UUID
 * @returns Distance in meters (rounded) and the configured geofence radius
 */
export async function calculateDistanceToSoffice(
  tx: Transaction,
  coords: { latitude: number; longitude: number },
  sofficeId: string,
  companyId: string
): Promise<SofficeDistanceResult> {
  const result = await tx.execute(
    sql`SELECT ST_DistanceSphere(
      ST_SetSRID(ST_MakePoint(${coords.longitude}, ${coords.latitude}), 4326),
      s.location_geom
    ) AS distance_meters,
    c.geofence_radius_meters
    FROM master_soffice s
    JOIN companies c ON c.id = s.company_id
    WHERE s.id = ${sofficeId}
      AND s.company_id = ${companyId}`
  )

  const row = result[0] as
    | { distance_meters: number; geofence_radius_meters: number }
    | undefined

  return {
    distance_meters: row?.distance_meters ? Math.round(row.distance_meters) : null,
    geofence_radius_meters: row?.geofence_radius_meters ?? 100,
  }
}
