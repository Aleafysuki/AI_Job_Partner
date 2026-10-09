import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const coreSrc = resolve(__dirname, '../../packages/core/src');
const sharedSrc = resolve(__dirname, 'src/shared');
const alias = {
  '@aijob/core': coreSrc,
  '@shared': sharedSrc,
};

/**
 * 主进程 / 预加载必须走 Node 内置模块与 Electron 原生模块，
 * 显式列为 external 可以避免打包器尝试解析 node:sqlite 这类较新的内置模块。
 */
const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'node:sqlite',
  'node:fs',
  'node:path',
  'node:module',
];

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    resolve: {
      alias: { ...alias, '@': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
