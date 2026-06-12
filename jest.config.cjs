/**
 * Root Jest config — runs all workspace projects.
 *
 * Each workspace owns its own jest.config.cjs because they have different
 * transform/runtime needs (Node + SWC for server/protocol, jest-expo preset
 * for mobile). The `projects` array delegates to each.
 *
 * Usage:
 *   pnpm test                 — all projects
 *   pnpm test:watch           — watch mode (interactive project picker)
 *   pnpm test:protocol        — only @aji/protocol
 *   pnpm test:server          — only server
 *   pnpm test:mobile          — only mobile
 */
/** @type {import('jest').Config} */
module.exports = {
  projects: [
    '<rootDir>/packages/protocol',
    '<rootDir>/apps/server',
    '<rootDir>/apps/mobile',
  ],
}
