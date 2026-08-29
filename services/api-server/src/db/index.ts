import { drizzle } from 'drizzle-orm/postgres-js'

import { sql as pgClient } from '../config/database'
import { setRLSContext } from './rls'
import type { RLSContext } from './rls'
import * as schema from './schema'
import * as relations from './relations'

export const db = drizzle(pgClient, { schema: { ...schema, ...relations } })

export type Database = typeof db
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export async function withRLS<T>(
  ctx: RLSContext,
  callback: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await setRLSContext(tx, ctx)
    return callback(tx)
  })
}

export * from './schema'
export * from './relations'
export { setRLSContext, clearRLSContext, RLS_VARIABLES } from './rls'
export type { RLSContext } from './rls'
export { calculateDistanceToSoffice } from './spatial'
export type { SofficeDistanceResult } from './spatial'
export { resolveGeofenceTarget, GeofenceResolutionError } from './geofence'
export type { GeofenceTarget, GeofenceResolvedFrom } from './geofence'
