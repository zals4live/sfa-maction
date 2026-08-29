import { sql } from 'drizzle-orm'

/**
 * PostgreSQL session variable names used for Row-Level Security enforcement.
 * These are set within transactions to scope queries by tenant, user, and role.
 */
export const RLS_VARIABLES = Object.freeze({
  COMPANY_ID: 'app.current_company_id',
  USER_ID: 'app.current_user_id',
  USER_ROLE: 'app.current_user_role',
} as const)

/**
 * Context required for RLS session variable setup.
 * Passed to setRLSContext to scope database queries within a transaction.
 */
export interface RLSContext {
  companyId: string
  userId: string
  userRole: string
}

/**
 * Minimal transaction interface required for RLS operations.
 * Accepts any Drizzle transaction object that supports execute().
 */
interface TransactionLike {
  execute(query: ReturnType<typeof sql>): Promise<unknown>
}

/**
 * Sets RLS session variables within a Drizzle transaction.
 * Must be called at the start of any transaction that accesses tenant-scoped tables.
 *
 * @throws {Error} If companyId or userId are empty strings
 */
export async function setRLSContext(
  tx: TransactionLike,
  ctx: RLSContext
): Promise<void> {
  if (!ctx.companyId) {
    throw new Error('RLS context requires a non-empty companyId')
  }
  if (!ctx.userId) {
    throw new Error('RLS context requires a non-empty userId')
  }

  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.COMPANY_ID}, ${ctx.companyId}, true)`
  )
  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.USER_ID}, ${ctx.userId}, true)`
  )
  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.USER_ROLE}, ${ctx.userRole}, true)`
  )
}

/**
 * Resets all RLS session variables to empty strings within a transaction.
 * Useful for cleanup in tests or super admin contexts that bypass tenant scoping.
 */
export async function clearRLSContext(tx: TransactionLike): Promise<void> {
  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.COMPANY_ID}, '', true)`
  )
  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.USER_ID}, '', true)`
  )
  await tx.execute(
    sql`SELECT set_config(${RLS_VARIABLES.USER_ROLE}, '', true)`
  )
}
