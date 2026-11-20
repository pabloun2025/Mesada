import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/mesada_test',
      UPLOAD_DIR: './data/test-uploads',
      LOG_LEVEL: 'silent',
      AUTH_RATE_LIMIT: '10000',
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
