// electron.vite.config.ts
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
var __electron_vite_injected_dirname = "D:\\Documents\\AI_Job_Partner\\apps\\desktop";
var coreSrc = resolve(__electron_vite_injected_dirname, "../../packages/core/src");
var sharedSrc = resolve(__electron_vite_injected_dirname, "src/shared");
var alias = {
  "@aijob/core": coreSrc,
  "@shared": sharedSrc
};
var nodeExternals = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
  "node:fs",
  "node:path",
  "node:module"
];
var electron_vite_config_default = defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    base: "./",
    resolve: {
      alias: { ...alias, "@": resolve(__electron_vite_injected_dirname, "src/renderer/src") }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") } }
    }
  }
});
export {
  electron_vite_config_default as default
};
