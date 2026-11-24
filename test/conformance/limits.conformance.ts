import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./helpers";
import { startTarget, type Target } from "./target";

let t: Target;
beforeEach(async () => {
  t = await startTarget();
});
afterEach(async () => {
  await t.stop();
});

describe("viewer frame and rate limits", () => {
  it("closes a viewer that sends a frame over 64 KiB with 1009", async () => {
    const v = await connect(t, "player");
    v.send(JSON.stringify({ type: "client-info", payload: { pad: "x".repeat(70 * 1024) } }));
    expect(await v.closed).toBe(1009);
  });

  it("closes a viewer that sends more than 20 messages in a second with 1008", async () => {
    const v = await connect(t, "player");
    const info = JSON.stringify({ type: "client-info", payload: { width: 1, height: 1, devicePixelRatio: 1 } });
    for (let i = 0; i < 25; i++) v.send(info);
    expect(await v.closed).toBe(1008);
  });

  it("keeps a viewer that stays within the rate", async () => {
    const v = await connect(t, "player");
    const info = JSON.stringify({ type: "client-info", payload: { width: 1, height: 1, devicePixelRatio: 1 } });
    for (let i = 0; i < 20; i++) v.send(info);
    await new Promise((r) => setTimeout(r, 300));
    expect(v.closeCode).toBeNull();
    v.close();
    await v.closed;
  });

  it("ignores an unparseable frame without closing", async () => {
    const v = await connect(t, "map");
    v.send("not json");
    await new Promise((r) => setTimeout(r, 200));
    expect(v.closeCode).toBeNull();
    v.close();
    await v.closed;
  });
});
