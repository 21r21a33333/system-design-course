import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
  },
});
