import { defineConfig } from 'vite';

// The 3D client. The sim in src/sim is engine-agnostic; Vite only bundles render/ui.
export default defineConfig({
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
