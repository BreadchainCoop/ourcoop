import { describe, expect, it } from "vitest";
import { NonceManager } from "../src/nonce-manager.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("nonce manager", () => {
  it("serializes concurrent submits: unique consecutive nonces, one fetch", async () => {
    let fetches = 0;
    const manager = new NonceManager(async () => {
      fetches++;
      await tick(); // a slow mock transport — allocations pile up behind it
      return 42;
    });

    const nonces = await Promise.all(
      Array.from({ length: 20 }, () => manager.allocate()),
    );
    expect(fetches).toBe(1);
    expect(nonces).toEqual(Array.from({ length: 20 }, (_, i) => 42 + i));
  });

  it("reset() refetches from the chain (gap/error recovery)", async () => {
    let count = 10;
    let fetches = 0;
    const manager = new NonceManager(async () => {
      fetches++;
      return count;
    });
    expect(await manager.allocate()).toBe(10);
    expect(await manager.allocate()).toBe(11);

    count = 50; // e.g. a tx we lost track of mined; pending count jumped
    manager.reset();
    expect(await manager.allocate()).toBe(50);
    expect(await manager.allocate()).toBe(51);
    expect(fetches).toBe(2);
  });

  it("a failed fetch does not wedge the queue", async () => {
    let calls = 0;
    const manager = new NonceManager(async () => {
      calls++;
      if (calls === 1) throw new Error("rpc down");
      return 5;
    });
    await expect(manager.allocate()).rejects.toThrow("rpc down");
    expect(await manager.allocate()).toBe(5);
  });

  it("interleaved reset during concurrent allocations stays serialized", async () => {
    let base = 0;
    const manager = new NonceManager(async () => {
      await tick();
      return base;
    });
    const first = Promise.all([manager.allocate(), manager.allocate()]);
    expect(await first).toEqual([0, 1]);
    base = 100;
    manager.reset();
    const second = Promise.all([manager.allocate(), manager.allocate()]);
    expect(await second).toEqual([100, 101]);
  });
});
