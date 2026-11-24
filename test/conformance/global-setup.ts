// The embedded target needs the real PlayerScreenServer bundled for Node with
// the player and map bundles inlined; the visual suite's harness build does
// exactly that.
export default async function globalSetup(): Promise<void> {
  if ((process.env.CONFORMANCE_TARGET ?? "embedded") !== "embedded") return;
  const { default: buildHarness } = await import("../visual/harness/build-host.mjs");
  await buildHarness();
}
