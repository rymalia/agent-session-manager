# Plan: migrate to Vite 8 (Rolldown/Oxc) — 2026-10-17

**Status:** assessed and trial-run; not yet applied to `main`.
**From → to:** `vite` 5.4.21 → **8.3.4**, `@vitejs/plugin-react` 4.7.0 → **6.1.2** (a matched
pair: plugin-react 6 peers `vite ^8`; plugin-react 4.7 peers `^4.2 || ^5 || ^6 || ^7`).
This crosses three majors, so the breaking changes of 6, 7 *and* 8 all apply.

## Verdict

**Migrate, in one step (5 → 8), with one CSS fix.** A full trial in an isolated worktree
passed build, the smoke test, live dev and preview servers, Fast Refresh, and a browser check.
The only regression found is a CSS minifier change (R1). The migration also closes a real
security gap in the current setup (R2). That gap is the strongest reason to do it.

## Evidence (trial run, isolated worktree, Node 24.18.0, darwin-arm64)

| Check | Vite 5.4.21 (today) | Vite 8.3.4 + plugin-react 6.1.2 |
|---|---|---|
| `npm install` | — | clean, `npm ls --all` valid, no peer warnings |
| `npm audit` | **7 advisories (5 high)**: vite `.map` traversal, `fs.deny` Windows bypass, esbuild dev-server CORS, postcss, browserslist, nanoid, source-map-js | **0** |
| `vite build` | 1.46 s, no warnings | **154 ms**, no warnings |
| `dist/` layout | `index.html`, `assets/index-*.{js,css}`, public files | identical layout; `index.html` identical modulo hashes |
| JS / CSS size | 187.38 / 20.77 kB | 186.60 / 20.61 kB |
| `npm test` (smoke) | 191 pass / 0 fail | **191 pass / 0 fail** |
| Dev + preview: `/`, `/api/sources`, `/api/conversations`, `/api/usage`, `/api/search`, `/api/agents` | 200 | 200 (both servers) |
| Traversal refs on `/api/conversation`, `/api/export` | 403 | 403 (both servers) |
| `Host: evil.example` → `/api/sources` | **200 (unprotected)** | **403** |
| Foreign `Origin` → CORS header on `/api` | none | none |
| Fast Refresh (`App.jsx`, `MiniStats.jsx` edits) | — | hot-updated, no full reload, page state kept, 0 console errors |
| `.topbar` computed `backdrop-filter` (Chrome 155, built app) | `blur(10px)` | **`none`** ← R1 |

## Risk register

| # | Risk | Severity | Status / mitigation |
|---|---|---|---|
| **R1** | **Lightning CSS (new default CSS minifier) drops the unprefixed `backdrop-filter`** at `src/index.css:32-33`. The unprefixed declaration comes before `-webkit-backdrop-filter`, and the minifier collapses the pair to the later, prefixed form. Chrome and Firefox don't accept the `-webkit-` form, so the sticky top bar loses its blur. **Only in `build`/`preview`**: dev doesn't minify, so it looks fine in dev. | Medium (visible regression, silent) | **Fix in this migration:** delete the `-webkit-backdrop-filter` line. Lightning CSS then emits both forms from `build.target` (verified: output has `-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)`). Swapping the two lines also works. |
| **R2** | **Today's API is reachable via DNS rebinding.** In Vite 5, plugin `configureServer`/`configurePreviewServer` middleware runs *before* Vite's Host check, so `/api/*` answers any `Host` (verified: 200 for `Host: evil.example` in dev and preview, while `/` gets 403). After a rebind, the attacker's page (`evil.example:5191` → 127.0.0.1) is *same-origin* with the server, so CORS never applies. The Host check is the only defence, and on Vite 5 it doesn't cover `/api`. Vite 7 moved Host/CORS validation ahead of plugin middleware (`migration-v7` "Advanced"). | High (current state) | **Fixed by migrating** (verified 403). No code needed. |
| R11 | **Pre-existing, not changed by this migration:** `/api/open`, `/api/agents/open`, `/api/agents/update` are side-effecting **GET** handlers with no method or `Origin`/`Sec-Fetch-Site` check (`vite.config.js:104-134`). A cross-site simple request (e.g. `<img src="http://localhost:5191/api/agents/update?id=…">`) carries a legitimate `Host: localhost`, so it passes the Host check on Vite 5 and 8 alike. CORS blocks reading the response, not running the action. Inputs are constrained (registry ids, `openPath`), which limits the impact. Whether Chrome's local-network-access protections block this is UNVERIFIED. | Medium | **Resolved separately** on branch `api-same-origin-guard`: `isCrossSiteRequest()` in `vite.config.js` rejects any `/api/*` request whose `Sec-Fetch-Site` isn't `same-origin`/`none`, or whose `Origin` isn't this exact origin. It also closes a read leak: Vite's default CORS trusts *any* loopback origin, so a page on another localhost port could read `/api/conversations`. |
| R3 | Uncommitted `server.allowedHosts: ['.trycloudflare.com']` (`vite.config.js:166`). On Vite 8 this allowlist now *also* gates `/api` (it didn't on Vite 5, see R2). Preview inherits it (`preview.allowedHosts` defaults to `server.allowedHosts`). It permits every `*.trycloudflare.com` host, and a tunnel exposes an unauthenticated transcript API. That conflicts with the localhost-only model in CLAUDE.md. | Policy decision | **Not part of this migration.** Keep it out of the migration commit; decide separately (drop it, narrow it to the exact tunnel host, or design auth if remote access is intended). Never "fix" a tunnel with `cors: true`. |
| R4 | npm optional native-binding pruning (npm/cli#7961). Rolldown and Lightning CSS ship per-platform binaries; a lockfile regenerated with a stale `node_modules` can omit them. | Low | Regenerate with the `npm install -D …` below, then confirm `node_modules/@rolldown/binding-darwin-arm64` and `node_modules/lightningcss-darwin-arm64` exist (verified present in the trial lock). |
| R5 | Config is now bundled by Rolldown, not esbuild. `vite.config.js` eagerly imports the whole backend graph (`node:sqlite`, `child_process`, a dynamic `import('./sources/index.js')` at `server/agents.js:276`). | Low | Verified working: dev, preview, and `/api/agents` all served. Fallback if it ever breaks: `vite --configLoader native`. |
| R6 | Default `build.target` moves from `modules` (Chrome 87 / Edge 88 / Firefox 78 / Safari 14) to `baseline-widely-available` (Chrome 111 / Edge 111 / Firefox 114 / Safari 16.4 / iOS 16.4). | None in practice | This drives JS syntax lowering *and* CSS output (Lightning CSS targets; this is why R1's fix gets the `-webkit-` prefix back). The app already requires newer browsers (`color-mix()`, the Popover API). Local single-user tool. |
| R7 | Oxc replaces esbuild for JS transform and minify; plugin-react 6 drops Babel. | Low | No `babel` option, decorators, `esbuild` config, or `rollupOptions` in the repo. Build, smoke, and Fast Refresh all pass. |
| R8 | Fast Refresh boundaries | None | Every `src/*.jsx` exports only a default component, so no mixed exports invalidate HMR. |
| R9 | Service worker caches the old shell | Low | `sw.js` is network-first. Bump `VERSION` (`'v3'` → `'v4'`, `public/sw.js:16`) anyway so the old caches get evicted, per CLAUDE.md's PWA rule. |
| R10 | `npm install` reports `fsevents` install script blocked by `allowScripts` | None | `fsevents` was already in the Vite 5 tree and ships a prebuilt binary. Ignore it; don't run `npm audit fix --force` or approve scripts reflexively. |

### Checked and ruled out (no action)

Vite 6: `resolve.conditions`, JSON stringify, extended HTML asset refs, postcss-load-config 6,
Sass modern API, library CSS names, SSR CSS, proxy WS bypass, Terser floor, CJS `strictRequires`,
`fs.cachedChecks`, dotenv-expand 12, Runtime → Module Runner API. Vite 7: Sass legacy API and
`splitVendorChunkPlugin` removal, Node 20.19+/22.12+ (repo already `>=24`). Vite 8:
`rollupOptions`→`rolldownOptions`, `esbuild`→`oxc`, `manualChunks`, `commonjsOptions`,
`customResolver`, `import.meta.hot.accept(url)`, `import.meta.url` in UMD/IIFE, `BundleError`.
None of these are used in the repo. `scripts/smoke-test.mjs` is the only script that touches Vite,
and only by importing `apiMiddleware` from `vite.config.js`. `export-parity.mjs` and the adapter
tests don't touch Vite at all.

## Steps

1. Branch from `main`. Keep the uncommitted `vite.config.js` `allowedHosts` hunk **out** of
   these commits (R3).
2. `npm install -D vite@8.3.4 @vitejs/plugin-react@6.1.2` (this writes caret ranges `^8.3.4` /
   `^6.1.2`; the lockfile pins the exact versions), then check the native bindings (R4) and
   `npm ls --all`.
3. `src/index.css`: delete line 33 (`-webkit-backdrop-filter: blur(10px);`) (R1).
4. `public/sw.js:16`: `VERSION = 'v4'` (R9).
5. No `vite.config.js` changes are required. `react()` stays optionless.
6. Verify (next section), then commit (e.g. *"Upgrade to Vite 8 and plugin-react 6"*, with
   R1/R2 in the body).
7. Afterwards: update the `avoid-npm-audit-fix-force` memory, which describes Vite 5 as the
   baseline.

## Verification

Automated: `npm ci && npm run build && npm test`. Gate on `FAIL 0`; the pass count depends on
local transcript data (191 in the trial). Optionally run
`node scripts/export-parity.mjs claude <some-transcript.jsonl>`. It takes `<source> <ref…>`
args and needs the upstream `extract-session.py`. The export path doesn't touch Vite, so this is
insurance only.

Manual, on the real `:5191` origin (this is where the installed service worker lives):
- `npm run dev` and `npm run preview`: list loads, search, a conversation opens, an export
  downloads, Usage and Agents panels render. Exercise `/api/open` and `/api/agents/update`
  through the UI (both are side-effecting, so they weren't probed in the trial).
- Built app: `.topbar` blur present (`getComputedStyle(...).backdropFilter === 'blur(10px)'`)
  in Chrome; spot-check Firefox if available.
- Built JS changed under Rolldown/Oxc (different bootstrap and minifier assumptions). The trial
  exercised it in Chrome 155. If you use Safari or Firefox, load the built app there once too.
- Service worker: after the first load, DevTools → Application shows the `-v4` caches only.
  The precache list is stable public paths only (`public/sw.js:21-27`); hashed JS/CSS are cached
  on first network fetch. Check this: load once, go offline in DevTools, reload, and the shell
  should still render.
- `curl -H 'Host: evil.example' localhost:5191/api/sources` → 403 on both servers.

**Rollback:** restore `package.json` and `package-lock.json` from the pre-migration commit,
`npm ci`, rebuild. The CSS and `sw.js` changes are harmless on Vite 5 and can stay.

## New in Vite 6 → 8 (what you get)

**Applies automatically, high value here**
- **Host/CORS validation before plugin middleware** (7.0). Closes R2 for `/api/*`.
- **Rolldown bundler + Oxc transformer/minifier** (8.0). Build drops 1.46 s → 0.15 s, with one
  bundler for dev pre-bundling and prod.
- **Lightning CSS minification** (8.0). Smaller CSS and modern syntax output (e.g.
  `@media (width<=640px)`), plus the R1 caveat.
- **Expanded `server.fs.deny` defaults** (8.1). Now covers `.env*`, certs/keys, `.npmrc`,
  `.yarnrc.yml`, and `.git/**`. This is defense in depth; the adapters' `isInside` checks remain
  the real boundary for `/api`.
- **HMR WebSocket token and secure CORS default** (6.0.9; the loopback-origin CORS allowance came
  in 6.0.11).
- plugin-react 6: **Oxc-based React Refresh, no Babel**. The lockfile goes from 109 to 46 package entries; most of the new
  entries are per-platform native bindings, and npm installs only the darwin-arm64 ones.

**Available, worth considering later**
- `server.forwardConsole` (8.0). Browser console output goes to the dev terminal, and it turns
  on automatically when a coding agent is detected. The app only logs one `pwa.js` warning, so
  there's no privacy concern.
- Vite DevTools (`devtools`, 8.0/8.3). Optional dev convenience.

**Not relevant to this repo**
Environment API / Module Runner / `buildApp` (framework/SSR); Full Bundle Mode and lazy
bundling (experimental); React Compiler (native Rust `compiler: true` is experimental, Babel
route via `@rolldown/plugin-babel`); `resolve.tsconfigPaths`, `emitDecoratorMetadata`
(TypeScript); `.wasm` imports / `?init` in SSR; `build.chunkImportMap`,
`html.additionalAssetSources`, import-map and worker features; library-mode
CSS/license/manifest features; Vite Task build caching (a build that takes 0.15 s doesn't need it).

## Sources

Official docs pinned to tags: `docs/guide/migration.md` @ v6.0.0 / v7.0.0 / v8.3.4,
`announcing-vite6/7/8.md`, `packages/vite/CHANGELOG.md` @ v8.3.4, plugin-react CHANGELOG and
README, `server-options.md`, `preview-options.md`. Six independent Codex (gpt-5.6-luna, xhigh)
read-only audits, one per slice (5→6, 6→8, plugin-react, server/security, new features,
tooling/verification). Every repo-affecting claim above was reproduced empirically or traced to
source.
