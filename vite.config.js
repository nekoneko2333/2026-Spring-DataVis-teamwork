import { defineConfig } from "vite";

// 大体数据(625MB)放在 public/data, 由 dev server 以静态 + Range 请求方式按需提供。
export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
    fs: { strict: false },
  },
  build: {
    target: "es2020",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
});
