import { defineConfig } from "vitest/config";

// Pure domain-logic tests (src/game/**). Unlike spec/, these don't need a
// running app, so they get their own config without spec/global-setup.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
