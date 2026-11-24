import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../protocol";
import { SESSION_PREFERENCE_KEYS } from "../integrations/prefs";

// The plugin and the remote server are two implementations of one contract,
// written in two languages, and nothing but these assertions stops them from
// drifting: a key the plugin sends and the server does not know is a silent
// 404 that loses a preference, and a protocol number that disagrees refuses
// every controller. The conformance suite proves behaviour against a running
// server; this reads the other side's source, so it fails in `make test`.
const serverSrc = (name: string) => readFileSync(join(__dirname, "..", "..", "server", "src", name), "utf8");

describe("plugin and remote server agree", () => {
  it("knows the same session preference keys", () => {
    const table = /const KNOWN: \[\(&str, Shape\); (\d+)\] = \[([\s\S]*?)\n\];/.exec(serverSrc("prefs.rs"));
    expect(table).not.toBeNull();
    const keys = [...table![2].matchAll(/\("([^"]+)",/g)].map((m) => m[1]);
    expect(Number(table![1])).toBe(keys.length);
    expect([...keys].sort()).toEqual([...SESSION_PREFERENCE_KEYS].sort());
  });

  it("speaks the same protocol version", () => {
    const rust = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(serverSrc("protocol.rs"));
    expect(rust).not.toBeNull();
    expect(Number(rust![1])).toBe(PROTOCOL_VERSION);
  });
});
