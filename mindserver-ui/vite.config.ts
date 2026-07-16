import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react()],
    root: __dirname,
    publicDir: false,
    build: {
        outDir: path.resolve(__dirname, '../src/mindcraft/public'),
        emptyOutDir: false,
        assetsDir: 'ui-assets',
    },
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'http://localhost:8080', changeOrigin: true },
            '/socket.io': { target: 'http://localhost:8080', ws: true, changeOrigin: true },
            '/settings_spec.json': { target: 'http://localhost:8080', changeOrigin: true },
            '/assets': { target: 'http://localhost:8080', changeOrigin: true },
        },
    },
});
