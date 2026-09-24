import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    sourcemap: true,
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-mcp-client',
        '@deepseek-ai/dsh-scope',
        '@deepseek-ai/schemastery',
      ],
    },
  },
  {
    // Browser half: loaded by the DSH web client through the `./client` export.
    // React is provided by the host, and the bundle must not pull host code in —
    // shared constants come from `src/shared.ts`, every host type is type-only.
    //
    // CJS on purpose: DSH composes several plugin bundles into one classic
    // script and materializes them through `factory(require)` (the Lazy-CJS
    // module table), so a statement-level `import`/`export` is a syntax error
    // that takes every other client plugin in the same batch down with it.
    // `scripts/wrap-client.mjs` then stamps the ModuleLoader shell around it.
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    // `"type": "module"` would otherwise make tsdown emit `client.cjs` /
    // `client.d.cts`, but the DSH module table resolves the bundle through
    // `exports["./client"]`, which names `lib/client.js`.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    sourcemap: true,
    dts: true,
    clean: false,
    // `react` is a platform singleton the shell seeds into the frozen module
    // table (`PLATFORM_MODULES` in the DSH checkout): the bundle must request it
    // through `factory(require)`, never inline a copy. The plugin reaches the
    // slot service through `ctx.slots`, so it needs no other platform module.
    deps: { neverBundle: ['react'] },
  },
] satisfies UserConfig[]
