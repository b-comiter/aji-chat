/**
 * Jest config for @aji/protocol — pure TypeScript in Node, no React, no DB.
 * Uses @swc/jest for fast TypeScript transforms (no ts-node startup cost).
 */
/** @type {import('jest').Config} */
module.exports = {
  displayName: '@aji/protocol',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2022',
        },
      },
    ],
  },
}
