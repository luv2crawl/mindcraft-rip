import { rmSync } from 'fs';

try {
    rmSync('src/mindcraft/public/ui-assets', { recursive: true });
} catch {
    /* ignore */
}
