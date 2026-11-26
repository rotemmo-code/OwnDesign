import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['unit', 'edge', 'regression', 'measure'].map(name => ({
      test: { name, include: [`tests/${name}/**/*.{test,measure}.ts`], allowOnly: false },
    })),
  },
});
