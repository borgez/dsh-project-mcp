/**
 * Vitest configuration.
 *
 * The repository keeps feature worktrees inside the checkout
 * (`.worktrees/<name>`, git-ignored), each with its own copy of `tests/`. The
 * default scan walks the whole tree, so a run from the main checkout would also
 * execute a worktree's tests — including the ones a parallel workstream is
 * still writing — and report them as this checkout's failures. Only `tests/` of
 * this checkout is this checkout's suite.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      // The plugin's own source, not the harnesses under `tests/` or the
      // build/audit scripts: those are exercised by running the suite, not by
      // measuring it.
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // `pnpm check` runs this reporter, so a surface added without its tests
      // fails the command a reviewer runs rather than a later reading. All four
      // readings are gated: a test that touches a line without exercising its
      // branch is exactly what the branch number is for.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
