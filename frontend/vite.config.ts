import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // React + router + query + the app; the mock backend is a separate lazy chunk.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    // API_PORT lets several checkouts run side by side (default 8000)
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 8000}` },
  },
})
