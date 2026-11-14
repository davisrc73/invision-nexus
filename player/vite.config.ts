import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: 'es2015', // Compatibilidade total com WebView / Chrome de fábrica das Boxes Android X98 Plus
    cssTarget: 'chrome61', // Impede o esbuild de converter top/left/right/bottom em 'inset: 0' (incompatível com Chrome < 87)
    cssMinify: false,
  },
  esbuild: {
    target: 'es2015',
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    cors: true,
  },
});
