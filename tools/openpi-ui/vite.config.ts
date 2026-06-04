import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webPort = Number(env.OPENPI_UI_WEB_PORT || process.env.OPENPI_UI_WEB_PORT || 18920);
  const apiPort = Number(env.OPENPI_UI_PORT || process.env.OPENPI_UI_PORT || 18921);
  return {
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: webPort,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
      "/ws": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: false,
      },
    },
  },
};
});
