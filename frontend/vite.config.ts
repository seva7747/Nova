import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // Large binary model assets (Porcupine's .pv/.ppn wake-word files) never
      // need hot-reload watching, and OneDrive syncing them can briefly lock
      // the file right as Vite's watcher tries to attach, crashing the dev
      // server with EBUSY. Just don't watch this folder's model files.
      ignored: ["**/public/*.pv", "**/public/*.ppn"],
    },
  },
});
