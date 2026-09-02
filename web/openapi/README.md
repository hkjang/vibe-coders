# OpenAPI contract workflow

`openapi/openapi.json` is the canonical, key-sorted snapshot of the Gateway's public
`GET /openapi.json` response. `src/shared/api/generated/` is generated from that snapshot by the
exact-pinned `@hey-api/openapi-ts` version in `package.json` and `pnpm-lock.yaml`; generated files
must not be edited by hand.

After changing a backend contract, start the Gateway and update both artifacts:

```sh
cd web
pnpm openapi:snapshot
```

The default source is `http://127.0.0.1:8080/openapi.json`. A downloaded file or another URL can be
provided explicitly:

```sh
pnpm openapi:snapshot -- ../openapi.json
pnpm openapi:snapshot -- http://127.0.0.1:18080/openapi.json
```

`pnpm openapi:generate` regenerates TypeScript from the committed snapshot without contacting the
Gateway. `pnpm openapi:check` validates the snapshot and regenerates into a temporary directory to
detect generated-code drift without modifying the worktree. CI additionally runs
`pnpm openapi:check -- ../openapi.json` against a freshly built Gateway, so both backend/snapshot
and snapshot/TypeScript drift fail the build.
