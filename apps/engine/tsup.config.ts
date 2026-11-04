import { defineConfig } from "tsup";

// One ESM bundle. Workspace packages are inlined so the runtime image needs
// no TypeScript and no path mapping; real dependencies stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: [/^@strowger\//],
  external: ["@prisma/client"],
});
