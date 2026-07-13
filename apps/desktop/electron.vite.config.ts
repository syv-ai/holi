import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @holi/shared ships raw TS — bundle it into main; real node deps stay external
  main: { plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })] },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
})
