import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // examples/ import 'stifinder' by name, as a user would. Under test that
    // is the source, not whatever was last built into dist/.
    alias: { stifinder: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
});
