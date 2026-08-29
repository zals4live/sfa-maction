import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const roleLabels = ['SUPER_ADMIN', 'ADMIN_PUSAT', 'ADMIN_CABANG', 'SALESMAN', 'MR'] as const

export const RoleLabelSchema = Type.Union(
  roleLabels.map((v) => Type.Literal(v)),
  { description: 'User role label matching user_label_enum' }
)

const UserProfileSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  email: Type.String({ format: 'email' }),
  full_name: Type.String(),
  phone_number: Type.Union([Type.String(), Type.Null()]),
  role_label: RoleLabelSchema,
  avatar_s3_key: Type.Union([Type.String(), Type.Null()]),
  lini_ids: Type.Array(Type.String({ format: 'uuid' })),
})

// --- Request Schemas ---

/** POST /auth/login — request body */
export const LoginBody = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 1 }),
})

// --- Response Schemas ---

/** POST /auth/login — success response */
export const LoginResponse = Type.Object({
  data: Type.Object({
    token: Type.String(),
    user: UserProfileSchema,
  }),
})

/** GET /auth/me — success response */
export const MeResponse = Type.Object({
  data: UserProfileSchema,
})

/** POST /auth/logout — success response */
export const LogoutResponse = Type.Object({
  data: Type.Object({
    success: Type.Literal(true),
  }),
})

// --- Static Types ---

export type LoginInput = Static<typeof LoginBody>
export type LoginResponseType = Static<typeof LoginResponse>
export type MeResponseType = Static<typeof MeResponse>
export type LogoutResponseType = Static<typeof LogoutResponse>
export type UserProfile = Static<typeof UserProfileSchema>
