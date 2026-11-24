import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, msg, sleep, Viewer } from "./helpers";
import { startTarget, type Target } from "./target";

let t: Target;
beforeEach(async () => {
  t = await startTarget({ maxClients: 3 });
});
afterEach(async () => {
  await t.stop();
});

describe("channel routing", () => {
  it("sends player messages to player viewers only and map messages to map viewers only", async () => {
    const player = await connect(t, "player");
    const map = await connect(t, "map");
    await t.broadcast(msg("combat-scale", { scale: 1.5 }));
    await t.broadcast(msg("map-view", { mode: "fit", panX: 0, panY: 0 }));
    await player.waitFor("combat-scale");
    await map.waitFor("map-view");
    await sleep(100);
    expect(player.types()).toEqual(["combat-scale"]);
    expect(map.types()).toEqual(["map-view"]);
    player.close();
    map.close();
  });

  it("routes /map with a query string to the map channel", async () => {
    await t.broadcast(msg("map-config", { pxPerSquare: 70 }));
    const map = await connect(t, "map");
    expect(map.types()).toEqual(["map-config"]);
    map.close();
  });
});

describe("client limit", () => {
  it("closes the viewer past the limit with 1013", async () => {
    const open = [await connect(t, "player"), await connect(t, "map"), await connect(t, "player")];
    const extra = new Viewer(t, "player");
    expect(await extra.closed).toBe(1013);
    for (const v of open) v.close();
  });
});
