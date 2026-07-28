import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  server: {
    port: 5177,
    open: true,
  },
  resolve: {
    alias: {
      "@chart": path.resolve(__dirname, "../src"),
    },
  },
});
