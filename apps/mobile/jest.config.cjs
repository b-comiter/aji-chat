/**
 * Jest config for the mobile app — uses Expo's preset to handle React Native
 * transforms, Expo modules, and the jsdom-ish environment that RN tests want.
 *
 * For pure helper tests (no React), the preset still works but adds overhead.
 * Keep complex helpers in sibling `*Helpers.ts` files to keep tests fast and
 * avoid pulling in component runtime when not needed.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  displayName: 'mobile',
  testMatch: ['<rootDir>/**/*.test.{ts,tsx}'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.expo/',
    '/android/',
    '/ios/',
    '/dist/',
  ],
}
