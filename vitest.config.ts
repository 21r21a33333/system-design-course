import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Docusaurus's shared tsconfig sets jsx: "preserve" for its own webpack pipeline;
  // override here so Vite's oxc transform can compile .tsx test files directly.
  oxc: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
  },
});
