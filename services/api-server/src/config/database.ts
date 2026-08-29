import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

const isProduction = process.env['NODE_ENV'] === 'production'

export const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/maction_dev'

if (isProduction && !process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL environment variable is required in production')
}

export const sql = postgres(DATABASE_URL, {
  max: Number(process.env['DB_POOL_MAX']) || (isProduction ? 20 : 5),
  idle_timeout: 30,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  ssl: isProduction ? { rejectUnauthorized: true } : false,
  prepare: true,
  connection: {
    application_name: 'maction-api',
  },
})

export const db = drizzle(sql)
