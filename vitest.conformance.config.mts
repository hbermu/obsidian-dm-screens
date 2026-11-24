import { defineConfig } from "vitest/config";

// The conformance suite talks to a real server over HTTP and WebSockets, so it
// runs in Node, one file at a time (each file starts its own server).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/conformance/**/*.conformance.ts"],
    globalSetup: ["test/conformance/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
