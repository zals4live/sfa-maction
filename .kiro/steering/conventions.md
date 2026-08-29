# Code Style & Naming Conventions

This steering file establishes the coding standards, formatting rules, and naming conventions for all code in KF Maction v2.0.

---

## General Principles

- **Single Responsibility**: Each function/method does one thing. Max 30 lines per function.
- **DRY**: Extract repeated logic into composables (frontend) or service functions (backend).
- **Explicit over Implicit**: Prefer named exports, explicit types, and clear variable names.
- **No Dead Code**: Remove unused imports, variables, and commented-out code before committing.

---

## TypeScript Rules

- Enable `strict: true` in all `tsconfig.json` files
- Prefer `interface` over `type` for object shapes (use `type` for unions/intersections)
- Always declare return types on exported functions
- Use `const` by default; `let` only when reassignment is required; never `var`
- Prefer `unknown` over `any` — narrow with type guards
- Use optional chaining (`?.`) and nullish coalescing (`??`) instead of manual null checks
- Discriminated unions for state machines (e.g., sync status, visit lifecycle)

---

## Vue / Nuxt Conventions

### Components

```vue
<script setup lang="ts">
// 1. Imports
// 2. Props & Emits
// 3. Composables & Stores
// 4. Reactive state (ref, computed)
// 5. Functions
// 6. Lifecycle hooks (onMounted, watch)
</script>

<template>
  <!-- Single root element preferred for clarity -->
</template>
```

- Always use `<script setup lang="ts">` — no Options API
- Props: use `defineProps<{}>()` with TypeScript generics
- Emits: use `defineEmits<{}>()` with typed event signatures
- Template refs: `useTemplateRef()` with typed generic

### Composables

- Prefix with `use`: `useGeofence()`, `useOfflineDb()`
- Return reactive refs and functions — never raw values
- Accept options object as parameter when configurable
- Co-locate composables with their feature when feature-specific

### Pages

- Use `definePageMeta({})` for middleware, layout, and auth requirements
- Page components should be thin — delegate logic to composables
- Dynamic route params use `[param]` folder/file syntax

---

## Elysia.js Backend Conventions

### Route Definitions

```typescript
// modules/{name}/routes.ts
export const customerRoutes = new Elysia({ prefix: '/customers' })
  .use(tenantGuard)
  .get('/', handler, { query: schema })
  .post('/', handler, { body: schema })
  .get('/:id', handler, { params: schema })
```

- One route file per module, exported as an Elysia instance with a prefix
- Validation schemas defined in `schemas.ts`, referenced inline
- Handler functions defined in `service.ts`, imported into routes

### Services

- Pure functions that accept explicit parameters (no implicit request context)
- Database access via injected pool/client — never create connections inside services
- Return typed result objects; throw typed errors for error cases

### Error Handling

- Use Elysia's `error()` helper for HTTP error responses
- Map database constraint violations to user-friendly messages
- Never expose internal error details (stack traces, SQL, table names) to clients

---

## Database & SQL Conventions

- Table names: `snake_case`, plural (`master_customer`, `visit_plans`, `order_items`)
- Column names: `snake_case` (`company_id`, `created_at`, `is_active`)
- Primary keys: `id UUID DEFAULT gen_random_uuid()`
- Foreign keys: `{referenced_table_singular}_id` (e.g., `company_id`, `user_id`, `customer_id`)
- Timestamps: Always `TIMESTAMPTZ` with `DEFAULT NOW()` for `created_at`
- Soft delete: `is_deleted BOOLEAN DEFAULT FALSE` + `deleted_at TIMESTAMPTZ` + `deleted_by UUID`
- Indexes: `idx_{table}_{column(s)}` (e.g., `idx_customer_company`)
- Unique constraints: `uq_{table}_{column(s)}` with partial index `WHERE deleted_at IS NULL`
- RLS policy names: `tenant_isolation_{table}`

---

## API Response Format

### Success Response

```json
{
  "data": { ... },
  "meta": { "page": 1, "limit": 20, "total": 150 }
}
```

### Error Response

```json
{
  "error": {
    "code": "GEOFENCE_OUT_OF_RANGE",
    "message": "You are 250m from the target location. Must be within 100m.",
    "details": { "distance_meters": 250, "max_radius": 100 }
  }
}
```

---

## Git Commit Convention

Use **Conventional Commits**:

```
feat(visit): add geofence radar validation on visit-in
fix(order): correct PPN tax calculation for multi-item carts
refactor(auth): extract JWT verification into shared middleware
docs(steering): add security patterns steering file
chore(deps): update @vue-leaflet/vue-leaflet to 0.10.1
test(attendance): add unit tests for check-in distance validation
```

Format: `{type}({scope}): {imperative description}`

Scopes match module names: `tenant`, `auth`, `attendance`, `customer`, `doctor`, `visit`, `order`, `sfa`, `pwa`, `erp`, `map`, `report`, `audit`

---

## Tailwind CSS / Nuxt UI Conventions

- Use Nuxt UI semantic color tokens (`primary`, `success`, `warning`, `error`) over raw hex
- Responsive design: mobile-first (`sm:`, `md:`, `lg:` breakpoints)
- Spacing: use Tailwind scale (4, 8, 12, 16, 24, 32, 48) — avoid arbitrary values
- Component variants via Nuxt UI `variant` and `color` props, not custom CSS
- **Forced Light Mode**: Dark mode is explicitly disabled. Both apps set `colorMode: { preference: 'light', fallback: 'light' }` in `nuxt.config.ts`. No dark mode classes, toggles, or `dark:` variants. This maximizes outdoor readability for field reps under direct sunlight.
- Design tokens follow the PRD semantic palette: `primary-500` (#1C4173), `success-500` (#10B981), `warning-500` (#D97706), `error-500` (#EF4444)

---

## Testing Conventions

- Unit tests colocated in `__tests__/` directories next to source
- Test file naming: `{source-file}.test.ts`
- Backend: use Bun's built-in test runner (`bun test`)
- Frontend: use Vitest with Vue Test Utils
- Test descriptions: `describe('{module}')` → `it('should {expected behavior}')`
- Mock external services (S3, Redis, ERP) in tests — never call real endpoints
