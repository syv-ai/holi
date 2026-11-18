import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  configFile: false,
  root: resolve(__dirname, 'src/mdx-compiler'),
  base: './',
  build: {
    target: 'es2022',
    outDir: resolve(__dirname, 'out/mdx-compiler'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/mdx-compiler/guest.html'),
      output: { entryFileNames: 'guest.js', format: 'iife', assetFileNames: '[name][extname]' },
    },
  },
})
