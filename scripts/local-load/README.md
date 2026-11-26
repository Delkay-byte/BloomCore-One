# Local 1,000-VU load test harness

Loopback-only, synthetic-data-only harness. See
`docs/LOCAL_1000_VU_LOAD_TEST_PLAN.md` and
`docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`.

## Safety

- `env.mjs` refuses any target other than `127.0.0.1:3101` and any database
  other than `tests/local-load.db`.
- Server env starts from an empty object; every outbound provider credential
  is blanked and re-checked before start.
- Port 3100, `tests/e2e.db`, `tests/test.db`, production hosts and real data
  are never touched.
- k6 is not installed. `generator.mjs` is the documented protocol-level
  equivalent with staged VUs, think times and real signed tab proofs.

## Order

```powershell
npm run build
node scripts/local-load/prepare-db.mjs
node scripts/local-load/start-server.mjs
node scripts/local-load/enroll.mjs
node scripts/local-load/generator.mjs --profile all --workers 4
node scripts/local-load/failure.mjs
node scripts/local-load/stop-server.mjs
```

`provider-mocks.mjs` is optional loopback tooling only; the app never calls it.
All results and samples are written to `tests/local-load-artifacts/`.
