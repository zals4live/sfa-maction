Menyiapkan pondasi infrastruktur, skema data, dan *boilerplates* secara manual akan menghemat banyak kuota token AI dan mencegah AI membuat kesalahan konfigurasi awal.

Berikut adalah daftar hal-hal konkret yang bisa disiapkan dan dijalankan terlebih dahulu:

---

### 1. Database & Runtime Engine (OrbStack & PostgreSQL PostGIS)

Jalankan container lokal dan eksekusi skema awal:

* **File `docker-compose.yml` (Local OrbStack)**
Buat dan jalankan service PostgreSQL 16 dengan ekstensi PostGIS serta Redis:

```yaml
services:
  postgres:
    image: postgis/postgis:16-3.4
    container_name: maction-postgres
    restart: always
    environment:
      POSTGRES_DB: maction_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgrespassword
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: maction-redis
    restart: always
    ports:
      - "6379:6379"

volumes:
  pgdata:

```

* **Koneksi TablePlus & Inisialisasi SQL**:
* Hubungkan TablePlus ke `localhost:5432`.
* Jalankan script DDL dari PRD (Section 6: pembuatan enum types, tabel master, junction `doctor_outlet_assignments`, dan RLS policies).

---

### 2. Monorepo & Package Manager Setup

Inisialisasi workspace monorepo menggunakan `pnpm`:

* **File `pnpm-workspace.yaml**`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"

```

* **Struktur Folder Awal**:

```bash
mkdir -p apps/web-portal apps/field-pwa services/api-server packages/types packages/utils infra/docker

```

---

### 3. Inisialisasi Project (Apps & Services)

Inisialisasi setiap sub-project dengan tool CLI resminya masing-masing:

* **Backend Service (`services/api-server`)**:

```bash
cd services/api-server
bun init -y
bun add elysia @elysiajs/jwt @elysiajs/cors @elysiajs/swagger postgres bullmq ioredis @sinclair/typebox
bun add -d @types/bun typescript

```

* **Web Portal (`apps/web-portal`)**:

```bash
cd ../../apps/web-portal
npx nuxi@latest init . --packageManager pnpm
pnpm add @nuxt/ui pinia @pinia/nuxt leaflet @vue-leaflet/vue-leaflet leaflet.markercluster @types/leaflet

```

* **Field PWA (`apps/field-pwa`)**:

```bash
cd ../field-pwa
npx nuxi@latest init . --packageManager pnpm
pnpm add @nuxt/ui @vite-pwa/nuxt pinia @pinia/nuxt dexie leaflet @vue-leaflet/vue-leaflet leaflet.markercluster @turf/turf

```

---

### 4. Boilerplate Setup File Konfigurasi

Siapkan file konfigurasi inti sebelum memanggil AI:

* **`apps/field-pwa/nuxt.config.ts`**:
Tambahkan modul `@vite-pwa/nuxt` dan konfigurasi PWA dasar (Service Worker, Manifest icons, offline precaching).
* **`apps/field-pwa/database/index.ts`**:
Salin kode Dexie.js Schema (Section 7 dari PRD) langsung ke file ini.
* **`packages/types/src/index.ts`**:
Definisikan interface TypeScript bersama (`Customer`, `DoctorProfile`, `DoctorOutletAssignment`, `Visit`, `Order`, `SyncStatus`).

---

### 5. AI Steering & Context Files (Kiro IDE Workspace)

Buat folder `.kiro/steering/` agar AI memiliki batasan teknis yang jelas tanpa perlu Anda jelaskan berulang-ulang di setiap prompt:

* **`.kiro/steering/tech.md`**:
Cantumkan ringkasan stack: *Bun v1.4 + Elysia.js, PostgreSQL 16 PostGIS, Nuxt 4, Nuxt UI, Dexie.js, Leaflet, multi-tenancy via RLS (`app.current_company_id`)*.
* **`.kiro/steering/structure.md`**:
Cantumkan diagram pohon direktori monorepo agar AI selalu menempatkan file baru di folder yang tepat.
