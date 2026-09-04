# api-server

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Performance testing (NFR-PERF-03: p95 ≤ 100ms)

Two complementary layers verify API response time under load.

### 1. Application-layer gate (always runnable, no infra)

`src/__tests__/perf/api-response-time.perf.test.ts` drives the real Elysia
handlers, middleware, and services in-process via `app.handle()` under
concurrent load, with Postgres/Redis/S3 mocked to near-zero latency. It
isolates and asserts the application-layer overhead the p95 budget protects.

```bash
# default profile: 2000 requests, 50 concurrent, p95 budget 100ms
bun test src/__tests__/perf/api-response-time.perf.test.ts

# heavier local run (override via env)
PERF_TOTAL_REQUESTS=20000 PERF_CONCURRENCY=200 bun test src/__tests__/perf/api-response-time.perf.test.ts
```

Each scenario prints a latency profile: `p50 / p95 / p99 / max / mean / rps`.

### 2. Live-server load test (requires full stack)

To measure true end-to-end latency including real DB/Redis over the network,
start the stack (`infra/docker` Postgres+Redis, then `bun run dev`) and point an
external HTTP load tool at it, e.g. `autocannon`:

```bash
# example — auth first, then hammer a representative endpoint for 30s @ 50 conns
npx autocannon -c 50 -d 30 -H "Authorization=Bearer $TOKEN" \
  http://localhost:3000/materials
```

Never commit tokens or credentials — supply them via environment variables.
