# KF Maction v2.0

Enterprise **Sales Force Automation (SFA)** & **Field Force Activity Monitoring** platform untuk PT Kimia Farma Tbk.

Monorepo pnpm yang berisi:

| Paket | Deskripsi | Tech |
|-------|-----------|------|
| `services/api-server` | Backend API | Elysia.js + Bun + Drizzle ORM + PostgreSQL/PostGIS + Redis |
| `apps/web-portal` | Portal admin desktop (SSR) | Nuxt 4 + Nuxt UI |
| `apps/field-pwa` | PWA mobile field force (Salesman & MR) | Nuxt 4 + PWA + Dexie.js |
| `packages/types` | Tipe TypeScript bersama | — |
| `packages/utils` | Utility bersama (Turf.js, exporter, dll) | — |

---

## Prasyarat

- [Bun](https://bun.sh) v1.4+
- [Node.js](https://nodejs.org) 20+ dan [pnpm](https://pnpm.io) 11+
- [Docker](https://orbstack.dev) (OrbStack / Docker Desktop) untuk PostgreSQL + Redis

---

## Setup Cepat

```bash
# 1. Install dependency seluruh workspace (dari root)
pnpm install

# 2. Jalankan PostgreSQL (PostGIS) + Redis via Docker
docker compose up -d

# 3. Bangun schema database dari init scripts (extensions, DDL, views, audit, RLS)
#    Root docker-compose.yml TIDAK auto-mount init scripts, jadi terapkan manual berurutan:
for f in 01_extensions 02_schema_ddl 03_reporting_views 04_audit_tables 05_rls_policies; do
  docker exec -i maction-postgres psql -v ON_ERROR_STOP=1 -U dbmaction_v2 -d dbmaction_v2 \
    < "infra/postgres/init-scripts/$f.sql"
done

# 4. Siapkan environment API server
cp services/api-server/.env.example services/api-server/.env
#    lalu isi DATABASE_URL / JWT_SECRET sesuai container (lihat bagian Konfigurasi)

# 5. Seed data awal (company, users, master data)
cd services/api-server && pnpm run db:seed
```

> Schema database dibangun dari file SQL di `infra/postgres/init-scripts/`, bukan dari
> `drizzle-kit migrate`. Jalankan langkah 3 setiap kali database baru/di-reset.

---

## Menjalankan Semua Layanan

Buka 3 terminal terpisah (atau jalankan di background):

```bash
# Terminal 1 — API server (Elysia + Bun)
cd services/api-server && bun run dev

# Terminal 2 — Web Portal (admin)
cd apps/web-portal && pnpm dev

# Terminal 3 — Field PWA
cd apps/field-pwa && pnpm dev
```

### Peta Port

| Layanan | URL | Port |
|---------|-----|------|
| API Server (Elysia) | http://localhost:3000 | 3000 |
| Field PWA | http://localhost:3001 | 3001 |
| Web Portal | http://localhost:3002 | 3002 |
| PostgreSQL | localhost:5432 | 5432 |
| Redis | localhost:6379 | 6379 |

> Port PWA & Web Portal dikunci lewat variabel `PORT` di masing-masing `.env` app agar tidak bentrok dengan API server (yang default di 3000).

---

## Cara Akses

### 1. Aplikasi Web (Admin Portal)

- **URL:** http://localhost:3002 → halaman `/` masih placeholder scaffold, mulai dari **http://localhost:3002/auth/login**
- SSR desktop admin (dashboard, tracking, reporting, master data).
- Panggilan API di-proxy same-origin: browser memanggil `/api/**`, lalu nitro `devProxy` meneruskan ke API server di `http://localhost:3000` (prefix `/api` di-strip).
- Login memakai kredensial akun admin di bawah. Setelah login diarahkan ke `/admin/dashboard`.

### 2. PWA (Field Force — Salesman & MR)

- **URL:** http://localhost:3001 → halaman `/` masih placeholder scaffold, mulai dari **http://localhost:3001/auth/login**
- Mobile PWA untuk attendance, kunjungan, order (Salesman), dan lookup harga/stok (MR).
- Sama seperti web-portal, memanggil API via proxy `/api/**` → `http://localhost:3000`.
- Untuk menguji instalasi PWA / tampilan mobile, gunakan device emulation di DevTools browser.
- Login memakai kredensial akun Salesman / MR di bawah.
- **Forced Light Mode:** modul color-mode dinonaktifkan (`ui: { colorMode: false }`), aplikasi selalu light untuk keterbacaan di luar ruangan.

### 3. Swagger (Dokumentasi API)

- **URL:** http://localhost:3000/swagger
- UI interaktif untuk seluruh endpoint Elysia (auth, order, visit, material, dll).
- Endpoint health check: http://localhost:3000/health (mengembalikan status `database` & `redis`).

Contoh login via cURL:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"salesman@maction.test","password":"Password123!"}'
```

### 4. Drizzle ORM (Database)

Semua perintah dijalankan dari `services/api-server`:

```bash
pnpm run db:studio      # Drizzle Studio — GUI browser untuk melihat/edit data
pnpm run db:generate    # Generate file migrasi SQL dari perubahan schema
pnpm run db:migrate     # Terapkan migrasi ke database
pnpm run db:push        # Sinkronkan schema langsung ke DB (dev only)
pnpm run db:seed        # Isi data awal (idempotent, aman diulang)
```

- **Drizzle Studio:** jalankan `pnpm run db:studio`, lalu buka URL yang tercetak di terminal (biasanya https://local.drizzle.studio).
- Definisi schema ada di `services/api-server/src/db/schema/`.
- Koneksi DB dibaca dari `DATABASE_URL` di `services/api-server/.env`.

Akses DB langsung via `psql` (opsional):

```bash
docker exec -it maction-postgres psql -U dbmaction_v2 -d dbmaction_v2
```

---

## Kredensial Seed (Local Dev)

Password untuk **semua** akun: `Password123!`

| Role | Email | Platform |
|------|-------|----------|
| SUPER_ADMIN | superadmin@maction.test | Web Portal |
| ADMIN_PUSAT | adminpusat@maction.test | Web Portal |
| ADMIN_CABANG | admincabang@maction.test | Web Portal |
| SALESMAN | salesman@maction.test | Field PWA |
| MR | mr@maction.test | Field PWA |

---

## Konfigurasi Environment

### `services/api-server/.env`

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://dbmaction_v2:<password>@localhost:5432/dbmaction_v2
REDIS_URL=redis://localhost:6379
JWT_SECRET=<isi-secret-anda>
```

> Kredensial PostgreSQL (user/password/db) ditentukan di `docker-compose.yml` root. Jika password memuat karakter khusus seperti `@`, lakukan URL-encode di `DATABASE_URL` (`@` → `%40`).

### `apps/web-portal/.env`

```env
PORT=3002
NUXT_PUBLIC_API_BASE=/api
API_BASE_URL=http://localhost:3000
```

### `apps/field-pwa/.env`

```env
PORT=3001
NUXT_PUBLIC_API_BASE=/api
API_BASE_URL=http://localhost:3000
```

> File `.env` tidak di-commit (sudah masuk `.gitignore`). Gunakan `.env.example` sebagai template.

---

## Struktur Repo

```
maction-v2/
├── apps/
│   ├── web-portal/     # Nuxt 4 admin portal
│   └── field-pwa/      # Nuxt 4 field force PWA
├── services/
│   └── api-server/     # Elysia + Drizzle backend
├── packages/
│   ├── types/          # Shared TypeScript types
│   └── utils/          # Shared utilities
├── infra/
│   ├── docker/         # Compose dev alternatif + init scripts
│   └── postgres/       # SQL init scripts (extensions, DDL, views, RLS)
├── docker-compose.yml  # PostgreSQL + Redis (dipakai untuk dev lokal)
└── pnpm-workspace.yaml
```

---

## Perintah Berguna

```bash
# Typecheck / lint per paket
pnpm --filter api-server run typecheck
pnpm --filter web-portal run lint

# Test
pnpm --filter api-server run test      # Bun test
pnpm --filter web-portal run test      # Vitest

# Stop database
docker compose down                    # hentikan container (data tetap)
docker compose down -v                 # hentikan + hapus volume (reset DB)
```

---

## Troubleshooting

- **Port bentrok / API tidak ketemu dari browser:** pastikan API di 3000, PWA di 3001, Web di 3002. Cek variabel `PORT` di tiap `.env`.
- **Halaman `/` terlihat kosong / placeholder:** ini normal — halaman root masih scaffold. Akses halaman fungsional lewat `/auth/login`, `/admin/dashboard` (web), atau `/app/*` (PWA).
- **Tampilan gelap/biru tua padahal harusnya light:** disebabkan nilai lama `nuxt-color-mode` di localStorage. Sudah diperbaiki dengan menonaktifkan modul color-mode (`ui: { colorMode: false }` di `nuxt.config.ts`). Jika masih gelap, restart dev server dan hard refresh; untuk PWA, unregister service worker di DevTools → Application.
- **Login gagal 401:** jalankan ulang `pnpm run db:seed` di `services/api-server`.
- **Login sukses tapi balik ke halaman login:** middleware auth membaca token dari key localStorage yang sama dengan auth store — pastikan `AUTH_TOKEN_STORAGE_KEY` di middleware cocok dengan yang ditulis store.
- **Schema tidak sinkron / tabel tidak ada:** reset DB dengan `docker compose down -v && docker compose up -d`, lalu terapkan ulang init scripts (lihat langkah 3 di **Setup Cepat**) dan `pnpm run db:seed`.
- **`@maction/types` tidak ditemukan:** jalankan `pnpm install` dari root (jangan buat `pnpm-workspace.yaml` di dalam folder app).
```
