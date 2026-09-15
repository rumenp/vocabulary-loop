import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
const isUserSite = repository?.toLowerCase().endsWith(".github.io");
const base = process.env.GITHUB_ACTIONS && repository && !isUserSite ? `/${repository}/` : "/";

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Vocabulary Loop",
        short_name: "Vocab Loop",
        description: "Build and repeat vocabulary audio playlists.",
        theme_color: "#17231d",
        background_color: "#f4f0e7",
        display: "standalone",
        start_url: ".",
        scope: "."
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,json}"],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024
      }
    })
  ]
});
