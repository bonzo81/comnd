import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1450,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Prevent Vite from scanning the massive Rust build output
  optimizeDeps: {
    exclude: [],
    entries: ["index.html"],
  },
});
