import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'AgentSDK',
      formats: ['es', 'umd'],
      fileName: (format) => `agent-sdk.${format}.js`,
    },
  },
});
