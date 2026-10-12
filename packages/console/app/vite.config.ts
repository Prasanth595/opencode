import { defineConfig, PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"

export default defineConfig({
  plugins: [
    solidStart({
      middleware: "./src/middleware.ts",
    }) as PluginOption,
    // SAFETY: Nitro supports Vite 7, but Windows hoisting resolves its plugin types against Vite 8.
    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }) as PluginOption,
  ],
  server: {
    allowedHosts: true,
    port: 3001,
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: false,
  },
})
