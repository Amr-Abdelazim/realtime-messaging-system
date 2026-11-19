import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'api',
                    include: ['apps/api/tests/**/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'worker',
                    include: ['apps/worker/tests/**/*.test.ts'],
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
        ],
    },
})