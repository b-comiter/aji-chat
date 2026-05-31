/**
 * Jest config for the server — Node + Hono + ws. Same setup as @aji/protocol.
 */
/** @type {import('jest').Config} */
module.exports = {
  displayName: 'server',
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
