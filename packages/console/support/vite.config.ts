import { defineConfig, PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"

export default defineConfig({
  plugins: [
    solidStart() as PluginOption,
    // SAFETY: Nitro supports Vite 7, but Windows hoisting resolves its plugin types against Vite 8.
    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare_module",
      cloudflare: {
        nodeCompat: true,
      },
    }) as PluginOption,
  ],
  server: {
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: false,
  },
})
