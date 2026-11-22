import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'api',
          include: ['apps/api/tests/**/*.test.ts'],
          setupFiles: ['apps/api/tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'worker',
          include: ['apps/worker/tests/**/*.test.ts'],
          setupFiles: ['apps/worker/tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/tests/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'contracts',
          include: ['packages/contracts/tests/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'client-core',
          include: ['packages/client-core/tests/**/*.test.ts'],
        },
      },
    ],
  },
})
