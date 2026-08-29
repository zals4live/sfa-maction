import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { LoginBody } from './schemas'
import { login, logout, getUserProfile, AuthServiceError } from './service'

/** Extracts client IP from proxy headers with fallback. */
function extractClientIp(headers: Record<string, string | undefined>): string {
  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  const realIp = headers['x-real-ip']
  if (realIp) return realIp.trim()

  return 'unknown'
}

export const authRoutes = new Elysia({ prefix: '/auth' })
  // --- Public Route: Login (no tenantGuard) ---
  .post(
    '/login',
    async ({ body, headers, set }) => {
      try {
        const clientIp = extractClientIp(headers)
        const result = await login(body, clientIp)
        return { data: result }
      } catch (err) {
        if (err instanceof AuthServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: LoginBody }
  )
  // --- Protected Routes (require tenantGuard) ---
  .group('', (app) =>
    app
      .use(tenantGuard)
      .post('/logout', async ({ claims }) => {
        await logout(claims!.company_id, claims!.user_id)
        return { data: { success: true as const } }
      })
      .get('/me', async ({ claims, set }) => {
        try {
          const user = await getUserProfile(claims!.user_id)
          return { data: user }
        } catch (err) {
          if (err instanceof AuthServiceError) {
            set.status = err.status
            return { error: { code: err.code, message: err.message } }
          }
          throw err
        }
      })
  )
