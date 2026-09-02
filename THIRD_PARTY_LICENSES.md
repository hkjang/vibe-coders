# Third-party licenses

이 문서는 Vibe Coders v0.82.0의 Go 실행 바이너리와 pnpm 잠금 그래프를 기준으로 생성한 통합 의존성 목록입니다.
React 운영 번들 의존성과 Frontend 빌드·테스트 도구를 함께 포함하며, 전체 라이선스 원문과 저작권 표시는 각 배포 패키지의 `LICENSE*` 파일을 따릅니다.

## Go gateway dependencies

| 구성요소 | 버전 | 라이선스 |
| --- | --- | --- |
| `filippo.io/edwards25519` | v1.2.0 | BSD-3-Clause |
| `github.com/dustin/go-humanize` | v1.0.1 | MIT |
| `github.com/go-sql-driver/mysql` | v1.10.0 | MPL-2.0 |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause |
| `github.com/jackc/pgpassfile` | v1.0.0 | MIT |
| `github.com/jackc/pgservicefile` | v0.0.0-20240606120523-5a60cdf6a761 | MIT |
| `github.com/jackc/pgx/v5` | v5.9.2 | MIT |
| `github.com/jackc/puddle/v2` | v2.2.2 | MIT |
| `github.com/remyoudompheng/bigfft` | v0.0.0-20230129092748-24d4a6f8daec | BSD-3-Clause |
| `github.com/sijms/go-ora/v2` | v2.9.0 | MIT |
| `golang.org/x/crypto` | v0.52.0 | BSD-3-Clause |
| `golang.org/x/sync` | v0.21.0 | BSD-3-Clause |
| `golang.org/x/sys` | v0.45.0 | BSD-3-Clause |
| `golang.org/x/text` | v0.39.0 | BSD-3-Clause |
| `modernc.org/libc` | v1.55.3 | BSD-3-Clause |
| `modernc.org/mathutil` | v1.6.0 | BSD-3-Clause |
| `modernc.org/memory` | v1.8.0 | BSD-3-Clause |
| `modernc.org/sqlite` | v1.34.5 | BSD-3-Clause |
| `stdlib` | go1.26.8 | BSD-3-Clause |

## React / npm dependency graph

| 구성요소 | 버전 | 라이선스 | 범위 |
| --- | --- | --- | --- |
| `@adobe/css-tools` | 4.5.0 | MIT | transitive |
| `@asamuzakjp/css-color` | 6.0.7 | MIT | transitive |
| `@asamuzakjp/dom-selector` | 8.3.2 | MIT | transitive |
| `@babel/code-frame` | 7.29.7 | MIT | transitive |
| `@babel/compat-data` | 7.29.7 | MIT | transitive |
| `@babel/core` | 7.29.7 | MIT | transitive |
| `@babel/generator` | 7.29.8 | MIT | transitive |
| `@babel/helper-compilation-targets` | 7.29.7 | MIT | transitive |
| `@babel/helper-globals` | 7.29.7 | MIT | transitive |
| `@babel/helper-module-imports` | 7.29.7 | MIT | transitive |
| `@babel/helper-module-transforms` | 7.29.7 | MIT | transitive |
| `@babel/helper-string-parser` | 7.29.7 | MIT | transitive |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT | transitive |
| `@babel/helper-validator-option` | 7.29.7 | MIT | transitive |
| `@babel/helpers` | 7.29.7 | MIT | transitive |
| `@babel/parser` | 7.29.8 | MIT | transitive |
| `@babel/runtime` | 7.29.7 | MIT | transitive |
| `@babel/template` | 7.29.7 | MIT | transitive |
| `@babel/traverse` | 7.29.8 | MIT | transitive |
| `@babel/types` | 7.29.8 | MIT | transitive |
| `@bramus/specificity` | 2.4.2 | MIT | transitive |
| `@csstools/color-helpers` | 6.1.1 | MIT-0 | transitive |
| `@csstools/css-calc` | 3.3.0 | MIT | transitive |
| `@csstools/css-color-parser` | 4.2.2 | MIT | transitive |
| `@csstools/css-parser-algorithms` | 4.0.0 | MIT | transitive |
| `@csstools/css-syntax-patches-for-csstree` | 1.1.12 | MIT-0 | transitive |
| `@csstools/css-tokenizer` | 4.0.0 | MIT | transitive |
| `@eslint-community/eslint-utils` | 4.10.1 | MIT | transitive |
| `@eslint-community/regexpp` | 4.12.2 | MIT | transitive |
| `@eslint/config-array` | 0.23.5 | Apache-2.0 | transitive |
| `@eslint/config-helpers` | 0.7.0 | Apache-2.0 | transitive |
| `@eslint/core` | 1.2.1 | Apache-2.0 | transitive |
| `@eslint/js` | 10.0.1 | MIT | build/test direct |
| `@eslint/object-schema` | 3.0.5 | Apache-2.0 | transitive |
| `@eslint/plugin-kit` | 0.7.2 | Apache-2.0 | transitive |
| `@exodus/bytes` | 1.15.1 | MIT | transitive |
| `@hey-api/codegen-core` | 0.9.1 | MIT | transitive |
| `@hey-api/json-schema-ref-parser` | 1.4.4 | MIT | transitive |
| `@hey-api/openapi-ts` | 0.99.0 | MIT | build/test direct |
| `@hey-api/shared` | 0.5.0 | MIT | transitive |
| `@hey-api/spec-types` | 0.2.0 | MIT | transitive |
| `@hey-api/types` | 0.1.4 | MIT | transitive |
| `@hookform/resolvers` | 5.9.1 | MIT | runtime direct |
| `@humanfs/core` | 0.19.2 | Apache-2.0 | transitive |
| `@humanfs/node` | 0.16.8 | Apache-2.0 | transitive |
| `@humanfs/types` | 0.15.0 | Apache-2.0 | transitive |
| `@humanwhocodes/module-importer` | 1.0.1 | Apache-2.0 | transitive |
| `@humanwhocodes/retry` | 0.4.3 | Apache-2.0 | transitive |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | transitive |
| `@jridgewell/remapping` | 2.3.5 | MIT | transitive |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | transitive |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | transitive |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | transitive |
| `@jsdevtools/ono` | 7.1.3 | MIT | transitive |
| `@lukeed/ms` | 2.0.2 | MIT | transitive |
| `@oxc-project/types` | 0.147.0 | MIT | transitive |
| `@playwright/test` | 1.62.1 | Apache-2.0 | build/test direct |
| `@radix-ui/primitive` | 1.1.7 | MIT | transitive |
| `@radix-ui/react-compose-refs` | 1.1.5 | MIT | transitive |
| `@radix-ui/react-context` | 1.2.2 | MIT | transitive |
| `@radix-ui/react-dialog` | 1.1.23 | MIT | runtime direct |
| `@radix-ui/react-dismissable-layer` | 1.1.19 | MIT | transitive |
| `@radix-ui/react-focus-guards` | 1.1.6 | MIT | transitive |
| `@radix-ui/react-focus-scope` | 1.1.16 | MIT | transitive |
| `@radix-ui/react-id` | 1.1.4 | MIT | transitive |
| `@radix-ui/react-portal` | 1.1.17 | MIT | transitive |
| `@radix-ui/react-presence` | 1.1.10 | MIT | transitive |
| `@radix-ui/react-primitive` | 2.1.10 | MIT | transitive |
| `@radix-ui/react-slot` | 1.3.3 | MIT | transitive |
| `@radix-ui/react-use-callback-ref` | 1.1.4 | MIT | transitive |
| `@radix-ui/react-use-controllable-state` | 1.2.6 | MIT | transitive |
| `@radix-ui/react-use-effect-event` | 0.0.5 | MIT | transitive |
| `@radix-ui/react-use-layout-effect` | 1.1.4 | MIT | transitive |
| `@rolldown/binding-android-arm-eabi` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-android-arm64` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-darwin-arm64` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-darwin-x64` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-freebsd-x64` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-arm-gnueabihf` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-arm64-gnu` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-arm64-musl` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-ppc64-gnu` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-s390x-gnu` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-linux-x64-gnu` | 1.2.6 | MIT | transitive |
| `@rolldown/binding-linux-x64-musl` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-openharmony-arm64` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-win32-arm64-msvc` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/binding-win32-x64-msvc` | 1.2.6 | NOASSERTION | transitive |
| `@rolldown/pluginutils` | 1.0.1 | MIT | transitive |
| `@standard-schema/spec` | 1.1.0 | MIT | transitive |
| `@standard-schema/utils` | 0.3.0 | MIT | transitive |
| `@tailwindcss/node` | 4.3.3 | MIT | transitive |
| `@tailwindcss/oxide-android-arm64` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-darwin-arm64` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-darwin-x64` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-freebsd-x64` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-linux-arm-gnueabihf` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-linux-arm64-gnu` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-linux-arm64-musl` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-linux-x64-gnu` | 4.3.3 | MIT | transitive |
| `@tailwindcss/oxide-linux-x64-musl` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-wasm32-wasi` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-win32-arm64-msvc` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide-win32-x64-msvc` | 4.3.3 | NOASSERTION | transitive |
| `@tailwindcss/oxide` | 4.3.3 | MIT | transitive |
| `@tailwindcss/vite` | 4.3.3 | MIT | build/test direct |
| `@tanstack/query-core` | 5.102.8 | MIT | transitive |
| `@tanstack/react-query` | 5.102.8 | MIT | runtime direct |
| `@tanstack/react-store` | 0.11.1 | MIT | transitive |
| `@tanstack/react-table` | 9.2.4 | MIT | runtime direct |
| `@tanstack/store` | 0.11.1 | MIT | transitive |
| `@tanstack/table-core` | 9.2.4 | MIT | transitive |
| `@testing-library/dom` | 10.4.1 | MIT | transitive |
| `@testing-library/jest-dom` | 7.0.1 | MIT | build/test direct |
| `@testing-library/react` | 16.3.3 | MIT | build/test direct |
| `@testing-library/user-event` | 14.6.6 | MIT | build/test direct |
| `@types/aria-query` | 5.0.4 | MIT | transitive |
| `@types/chai` | 5.2.3 | MIT | transitive |
| `@types/deep-eql` | 4.0.2 | MIT | transitive |
| `@types/esrecurse` | 4.3.1 | MIT | transitive |
| `@types/estree` | 1.0.9 | MIT | transitive |
| `@types/json-schema` | 7.0.15 | MIT | transitive |
| `@types/node` | 24.13.3 | MIT | build/test direct |
| `@types/react-dom` | 19.2.5 | MIT | build/test direct |
| `@types/react` | 19.2.18 | MIT | build/test direct |
| `@typescript-eslint/eslint-plugin` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/parser` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/project-service` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/scope-manager` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/tsconfig-utils` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/type-utils` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/types` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/typescript-estree` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/utils` | 8.69.0 | MIT | transitive |
| `@typescript-eslint/visitor-keys` | 8.69.0 | MIT | transitive |
| `@vitejs/plugin-react` | 6.1.1 | MIT | build/test direct |
| `@vitest/expect` | 4.1.11 | MIT | transitive |
| `@vitest/mocker` | 4.1.11 | MIT | transitive |
| `@vitest/pretty-format` | 4.1.11 | MIT | transitive |
| `@vitest/runner` | 4.1.11 | MIT | transitive |
| `@vitest/snapshot` | 4.1.11 | MIT | transitive |
| `@vitest/spy` | 4.1.11 | MIT | transitive |
| `@vitest/utils` | 4.1.11 | MIT | transitive |
| `acorn-jsx` | 5.3.2 | MIT | transitive |
| `acorn` | 8.18.0 | MIT | transitive |
| `ajv` | 6.15.0 | MIT | transitive |
| `ansi-colors` | 4.1.3 | MIT | transitive |
| `ansi-regex` | 5.0.1 | MIT | transitive |
| `ansi-styles` | 5.2.0 | MIT | transitive |
| `argparse` | 2.0.1 | Python-2.0 | transitive |
| `aria-hidden` | 1.2.6 | MIT | transitive |
| `aria-query` | 5.3.0 | Apache-2.0 | transitive |
| `aria-query` | 5.3.2 | Apache-2.0 | transitive |
| `assertion-error` | 2.0.1 | MIT | transitive |
| `axe-core` | 4.13.0 | MPL-2.0 | build/test direct |
| `balanced-match` | 4.0.4 | MIT | transitive |
| `baseline-browser-mapping` | 2.11.20 | Apache-2.0 | transitive |
| `bidi-js` | 1.0.3 | MIT | transitive |
| `brace-expansion` | 5.0.9 | MIT | transitive |
| `browserslist` | 4.28.8 | MIT | transitive |
| `bundle-name` | 4.1.0 | MIT | transitive |
| `c12` | 3.3.4 | MIT | transitive |
| `caniuse-lite` | 1.0.30001810 | CC-BY-4.0 | transitive |
| `chai` | 6.2.2 | MIT | transitive |
| `chokidar` | 5.0.0 | MIT | transitive |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | runtime direct |
| `clsx` | 2.1.1 | MIT | runtime direct |
| `color-support` | 1.1.3 | ISC | transitive |
| `commander` | 15.0.0 | MIT | transitive |
| `confbox` | 0.2.4 | MIT | transitive |
| `convert-source-map` | 2.0.0 | MIT | transitive |
| `cookie-es` | 3.1.1 | MIT | transitive |
| `cross-spawn` | 7.0.6 | MIT | transitive |
| `css-tree` | 3.2.1 | MIT | transitive |
| `css.escape` | 1.5.1 | MIT | transitive |
| `csstype` | 3.2.3 | MIT | transitive |
| `data-urls` | 7.0.0 | MIT | transitive |
| `debug` | 4.4.3 | MIT | transitive |
| `decimal.js` | 10.6.0 | MIT | transitive |
| `deep-is` | 0.1.4 | MIT | transitive |
| `default-browser-id` | 5.0.1 | MIT | transitive |
| `default-browser` | 5.5.1 | MIT | transitive |
| `define-lazy-prop` | 3.0.0 | MIT | transitive |
| `defu` | 6.1.7 | MIT | transitive |
| `dequal` | 2.0.3 | MIT | transitive |
| `destr` | 2.0.5 | MIT | transitive |
| `detect-libc` | 2.1.2 | Apache-2.0 | transitive |
| `detect-node-es` | 1.1.0 | MIT | transitive |
| `dom-accessibility-api` | 0.5.16 | MIT | transitive |
| `dom-accessibility-api` | 0.6.3 | MIT | transitive |
| `dotenv` | 17.4.2 | BSD-2-Clause | transitive |
| `electron-to-chromium` | 1.5.417 | ISC | transitive |
| `enhanced-resolve` | 5.24.5 | MIT | transitive |
| `entities` | 8.0.0 | BSD-2-Clause | transitive |
| `es-module-lexer` | 2.3.2 | MIT | transitive |
| `escalade` | 3.2.0 | MIT | transitive |
| `escape-string-regexp` | 4.0.0 | MIT | transitive |
| `eslint-plugin-react-hooks` | 7.1.1 | MIT | build/test direct |
| `eslint-plugin-react-refresh` | 0.5.5 | MIT | build/test direct |
| `eslint-scope` | 9.1.2 | BSD-2-Clause | transitive |
| `eslint-visitor-keys` | 3.4.3 | Apache-2.0 | transitive |
| `eslint-visitor-keys` | 5.0.1 | Apache-2.0 | transitive |
| `eslint` | 10.9.1 | MIT | build/test direct |
| `espree` | 11.2.0 | BSD-2-Clause | transitive |
| `esquery` | 1.7.0 | BSD-3-Clause | transitive |
| `esrecurse` | 4.3.0 | BSD-2-Clause | transitive |
| `estraverse` | 5.3.0 | BSD-2-Clause | transitive |
| `estree-walker` | 3.0.3 | MIT | transitive |
| `esutils` | 2.0.3 | BSD-2-Clause | transitive |
| `expect-type` | 1.4.0 | Apache-2.0 | transitive |
| `exsolve` | 1.1.1 | MIT | transitive |
| `fast-deep-equal` | 3.1.3 | MIT | transitive |
| `fast-json-stable-stringify` | 2.1.0 | MIT | transitive |
| `fast-levenshtein` | 2.0.6 | MIT | transitive |
| `fdir` | 6.5.0 | MIT | transitive |
| `file-entry-cache` | 8.0.0 | MIT | transitive |
| `find-up` | 5.0.0 | MIT | transitive |
| `flat-cache` | 4.0.1 | MIT | transitive |
| `flatted` | 3.4.4 | ISC | transitive |
| `fsevents` | 2.3.2 | NOASSERTION | transitive |
| `fsevents` | 2.3.3 | NOASSERTION | transitive |
| `gensync` | 1.0.0-beta.2 | MIT | transitive |
| `get-nonce` | 1.0.1 | MIT | transitive |
| `get-tsconfig` | 4.14.0 | MIT | transitive |
| `giget` | 3.3.1 | MIT | transitive |
| `glob-parent` | 6.0.2 | ISC | transitive |
| `globals` | 17.11.0 | MIT | build/test direct |
| `graceful-fs` | 4.2.11 | ISC | transitive |
| `hermes-estree` | 0.25.1 | MIT | transitive |
| `hermes-parser` | 0.25.1 | MIT | transitive |
| `html-encoding-sniffer` | 6.0.0 | MIT | transitive |
| `ignore` | 5.3.2 | MIT | transitive |
| `ignore` | 7.0.8 | MIT | transitive |
| `imurmurhash` | 0.1.4 | MIT | transitive |
| `indent-string` | 4.0.0 | MIT | transitive |
| `is-docker` | 3.0.0 | MIT | transitive |
| `is-extglob` | 2.1.1 | MIT | transitive |
| `is-glob` | 4.0.3 | MIT | transitive |
| `is-in-ssh` | 1.0.0 | MIT | transitive |
| `is-inside-container` | 1.0.0 | MIT | transitive |
| `is-potential-custom-element-name` | 1.0.1 | MIT | transitive |
| `is-wsl` | 3.1.1 | MIT | transitive |
| `isexe` | 2.0.0 | ISC | transitive |
| `jiti` | 2.7.0 | MIT | transitive |
| `js-tokens` | 4.0.0 | MIT | transitive |
| `js-yaml` | 4.3.1 | MIT | transitive |
| `jsdom` | 30.0.1 | MIT | build/test direct |
| `jsesc` | 3.1.0 | MIT | transitive |
| `json-buffer` | 3.0.1 | MIT | transitive |
| `json-schema-traverse` | 0.4.1 | MIT | transitive |
| `json-stable-stringify-without-jsonify` | 1.0.1 | MIT | transitive |
| `json5` | 2.2.3 | MIT | transitive |
| `keyv` | 4.5.4 | MIT | transitive |
| `levn` | 0.4.1 | MIT | transitive |
| `lightningcss-android-arm64` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-android-arm64` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-darwin-arm64` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-darwin-arm64` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-darwin-x64` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-darwin-x64` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-freebsd-x64` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-freebsd-x64` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm-gnueabihf` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm-gnueabihf` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm64-gnu` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm64-gnu` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm64-musl` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-linux-arm64-musl` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-linux-x64-gnu` | 1.32.0 | MPL-2.0 | transitive |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | transitive |
| `lightningcss-linux-x64-musl` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-linux-x64-musl` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-win32-arm64-msvc` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-win32-arm64-msvc` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss-win32-x64-msvc` | 1.32.0 | NOASSERTION | transitive |
| `lightningcss-win32-x64-msvc` | 1.33.0 | NOASSERTION | transitive |
| `lightningcss` | 1.32.0 | MPL-2.0 | transitive |
| `lightningcss` | 1.33.0 | MPL-2.0 | transitive |
| `locate-path` | 6.0.0 | MIT | transitive |
| `lru-cache` | 11.5.2 | BlueOak-1.0.0 | transitive |
| `lru-cache` | 5.1.1 | ISC | transitive |
| `lucide-react` | 1.38.0 | ISC | runtime direct |
| `lz-string` | 1.5.0 | MIT | transitive |
| `magic-string` | 0.30.21 | MIT | transitive |
| `mdn-data` | 2.27.1 | CC0-1.0 | transitive |
| `min-indent` | 1.0.1 | MIT | transitive |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 | transitive |
| `ms` | 2.1.3 | MIT | transitive |
| `nanoid` | 3.3.18 | MIT | transitive |
| `natural-compare` | 1.4.0 | MIT | transitive |
| `node-releases` | 2.0.54 | MIT | transitive |
| `obug` | 2.1.4 | MIT | transitive |
| `ohash` | 2.0.12 | MIT | transitive |
| `open` | 11.0.0 | MIT | transitive |
| `optionator` | 0.9.4 | MIT | transitive |
| `p-limit` | 3.1.0 | MIT | transitive |
| `p-locate` | 5.0.0 | MIT | transitive |
| `parse5` | 8.0.1 | MIT | transitive |
| `path-exists` | 4.0.0 | MIT | transitive |
| `path-key` | 3.1.1 | MIT | transitive |
| `pathe` | 2.0.3 | MIT | transitive |
| `perfect-debounce` | 2.1.0 | MIT | transitive |
| `picocolors` | 1.1.1 | ISC | transitive |
| `picomatch` | 4.0.7 | MIT | transitive |
| `pkg-types` | 2.3.1 | MIT | transitive |
| `playwright-core` | 1.62.1 | Apache-2.0 | transitive |
| `playwright` | 1.62.1 | Apache-2.0 | transitive |
| `postcss` | 8.5.26 | MIT | transitive |
| `powershell-utils` | 0.1.0 | MIT | transitive |
| `prelude-ls` | 1.2.1 | MIT | transitive |
| `prettier-plugin-tailwindcss` | 0.8.1 | MIT | build/test direct |
| `prettier` | 3.9.6 | MIT | build/test direct |
| `pretty-format` | 27.5.1 | MIT | transitive |
| `punycode` | 2.3.1 | MIT | transitive |
| `rc9` | 3.0.1 | MIT | transitive |
| `react-dom` | 19.2.8 | MIT | runtime direct |
| `react-hook-form` | 7.87.0 | MIT | runtime direct |
| `react-is` | 17.0.2 | MIT | transitive |
| `react-remove-scroll-bar` | 2.3.8 | MIT | transitive |
| `react-remove-scroll` | 2.7.2 | MIT | transitive |
| `react-router` | 8.3.1 | MIT | runtime direct |
| `react-style-singleton` | 2.2.3 | MIT | transitive |
| `react` | 19.2.8 | MIT | runtime direct |
| `readdirp` | 5.1.1 | MIT | transitive |
| `redent` | 3.0.0 | MIT | transitive |
| `require-from-string` | 2.0.2 | MIT | transitive |
| `resolve-pkg-maps` | 1.0.0 | MIT | transitive |
| `rolldown` | 1.2.6 | MIT | transitive |
| `run-applescript` | 7.1.0 | MIT | transitive |
| `saxes` | 6.0.0 | ISC | transitive |
| `scheduler` | 0.27.0 | MIT | transitive |
| `semver` | 6.3.1 | ISC | transitive |
| `semver` | 7.8.4 | ISC | transitive |
| `semver` | 7.8.5 | ISC | transitive |
| `shebang-command` | 2.0.0 | MIT | transitive |
| `shebang-regex` | 3.0.0 | MIT | transitive |
| `siginfo` | 2.0.0 | ISC | transitive |
| `sonner` | 2.0.8 | MIT | runtime direct |
| `source-map-js` | 1.2.1 | BSD-3-Clause | transitive |
| `stackback` | 0.0.2 | MIT | transitive |
| `std-env` | 4.2.0 | MIT | transitive |
| `strip-indent` | 3.0.0 | MIT | transitive |
| `symbol-tree` | 3.2.4 | MIT | transitive |
| `tailwind-merge` | 3.6.0 | MIT | runtime direct |
| `tailwindcss` | 4.3.3 | MIT | build/test direct |
| `tapable` | 2.3.3 | MIT | transitive |
| `tinybench` | 2.9.0 | MIT | transitive |
| `tinyexec` | 1.3.0 | MIT | transitive |
| `tinyglobby` | 0.2.17 | MIT | transitive |
| `tinyrainbow` | 3.1.1 | MIT | transitive |
| `tldts-core` | 7.4.11 | MIT | transitive |
| `tldts` | 7.4.11 | MIT | transitive |
| `tough-cookie` | 6.0.2 | BSD-3-Clause | transitive |
| `tr46` | 6.0.0 | MIT | transitive |
| `ts-api-utils` | 2.5.0 | MIT | transitive |
| `tslib` | 2.8.1 | 0BSD | transitive |
| `type-check` | 0.4.0 | MIT | transitive |
| `typescript-eslint` | 8.69.0 | MIT | build/test direct |
| `typescript` | 6.0.3 | Apache-2.0 | build/test direct |
| `undici-types` | 7.18.2 | MIT | transitive |
| `undici` | 8.10.1 | MIT | transitive |
| `update-browserslist-db` | 1.3.2 | MIT | transitive |
| `uri-js` | 4.4.1 | BSD-2-Clause | transitive |
| `use-callback-ref` | 1.3.3 | MIT | transitive |
| `use-sidecar` | 1.1.3 | MIT | transitive |
| `use-sync-external-store` | 1.6.0 | MIT | transitive |
| `vite` | 8.2.2 | MIT | build/test direct |
| `vitest` | 4.1.11 | MIT | build/test direct |
| `w3c-xmlserializer` | 5.0.0 | MIT | transitive |
| `webidl-conversions` | 8.0.1 | BSD-2-Clause | transitive |
| `whatwg-mimetype` | 5.0.0 | MIT | transitive |
| `whatwg-url` | 16.0.1 | MIT | transitive |
| `whatwg-url` | 17.1.0 | MIT | transitive |
| `which` | 2.0.2 | ISC | transitive |
| `why-is-node-running` | 2.3.0 | MIT | transitive |
| `word-wrap` | 1.2.5 | MIT | transitive |
| `wsl-utils` | 0.3.1 | MIT | transitive |
| `xml-name-validator` | 5.0.0 | Apache-2.0 | transitive |
| `xmlchars` | 2.2.0 | MIT | transitive |
| `yallist` | 3.1.1 | ISC | transitive |
| `yocto-queue` | 0.1.0 | MIT | transitive |
| `zod-validation-error` | 4.0.2 | MIT | transitive |
| `zod` | 4.5.4 | MIT | runtime direct |
| `zustand` | 5.0.15 | MIT | runtime direct |

## Scope and verification

- `/app`은 모든 JavaScript, CSS, 아이콘을 Go 바이너리에 embed하며 런타임 CDN이나 Node.js를 요구하지 않습니다.
- `NOASSERTION`은 잠금 파일 또는 설치 메타데이터에서 SPDX 식을 확정하지 못했다는 뜻이며, 무라이선스를 의미하지 않습니다.
- 최종 Distroless 이미지의 운영체제 구성요소는 릴리스 이미지 digest를 대상으로 별도 Syft 스캔해야 합니다.
- `seed.sql`, `.gitframe/`, `output/`은 릴리스 및 커밋 범위에서 제외됩니다.

재생성: `scripts/generate-source-sbom.sh v0.82.0`
