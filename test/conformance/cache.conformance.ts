import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, msg } from "./helpers";
import { onlyOn, startTarget, type Target } from "./target";

let t: Target;
beforeEach(async () => {
  t = await startTarget();
});
afterEach(async () => {
  await t.stop();
});

async function replayed(channel: "player" | "map") {
  const v = await connect(t, channel);
  v.close();
  return v.messages;
}

describe("late-joiner replay", () => {
  it("replays one entry per type with the latest payload, in first-insertion order", async () => {
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("waiting-screen", { title: "A", subtitle: "" }));
    await t.broadcast(msg("combat-scale", { scale: 2 }));
    expect(await replayed("player")).toEqual([
      msg("combat-scale", { scale: 2 }),
      msg("waiting-screen", { title: "A", subtitle: "" }),
    ]);
  });

  it("keeps sync ahead of geometry", async () => {
    await t.broadcast(msg("image-layers-sync", { layers: [] }));
    await t.broadcast(msg("image-layers-geometry", { layers: [] }));
    await t.broadcast(msg("image-layers-sync", { layers: [] }));
    await t.broadcast(msg("image-layers-geometry", { layers: [] }));
    expect((await replayed("player")).map((m) => m.type)).toEqual(["image-layers-sync", "image-layers-geometry"]);
  });

  it("replays only the joiner's channel", async () => {
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("map-config", { pxPerSquare: 70 }));
    expect((await replayed("player")).map((m) => m.type)).toEqual(["combat-scale"]);
    expect((await replayed("map")).map((m) => m.type)).toEqual(["map-config"]);
  });
});

describe("purge rules", () => {
  it("clear purges the player channel only and is not cached", async () => {
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("map-config", { pxPerSquare: 70 }));
    await t.broadcast(msg("clear"));
    expect(await replayed("player")).toEqual([]);
    expect((await replayed("map")).map((m) => m.type)).toEqual(["map-config"]);
  });

  it("map-clear purges the map channel except map-calibration and is not cached", async () => {
    await t.broadcast(msg("map-calibration", { profiles: {} }));
    await t.broadcast(msg("map-view", { mode: "fit", panX: 0, panY: 0, rotation: 0 }));
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("map-clear"));
    expect((await replayed("map")).map((m) => m.type)).toEqual(["map-calibration"]);
    expect((await replayed("player")).map((m) => m.type)).toEqual(["combat-scale"]);
  });

  it("hide-background-media deletes the background and is not cached", async () => {
    await t.broadcast(msg("show-background-media", { url: "data:image/png;base64,AA==", mediaType: "image" }));
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("hide-background-media"));
    expect((await replayed("player")).map((m) => m.type)).toEqual(["combat-scale"]);
  });

  it("delivers clear and hide-background-media live even though they are not cached", async () => {
    const v = await connect(t, "player");
    await t.broadcast(msg("hide-background-media"));
    await t.broadcast(msg("clear"));
    await v.waitFor("clear");
    expect(v.types()).toEqual(["hide-background-media", "clear"]);
    v.close();
  });
});

describe("budget", () => {
  // Each entry stays under the remote control channel's 1 MiB frame cap; the
  // three together exceed the 2 MiB budget.
  it("evicts the largest entry past 2 MiB", async () => {
    const pad = (mib: number) => "x".repeat(Math.floor(mib * 1024 * 1024));
    await t.broadcast(msg("combat-scale", { scale: 1 }));
    await t.broadcast(msg("waiting-screen", { title: pad(0.8), subtitle: "" }));
    await t.broadcast(msg("initiative-update", { combatants: [], round: 1, pad: pad(0.9) }));
    await t.broadcast(msg("viewport-update", { panX: 0, panY: 0, zoom: 1, pad: pad(0.7) }));
    expect((await replayed("player")).map((m) => m.type)).toEqual(["combat-scale", "waiting-screen", "viewport-update"]);
  });

  it.runIf(onlyOn("embedded"))("never evicts the last entry", async () => {
    await t.broadcast(msg("waiting-screen", { title: "y".repeat(3 * 1024 * 1024), subtitle: "" }));
    expect((await replayed("player")).map((m) => m.type)).toEqual(["waiting-screen"]);
  });
});
