import { describe, expect, it, vi } from "vitest";
import dmdb from "dmdb";
import { DamengConnector } from "../dameng/index.js";

describe("Dameng connector connection pool recovery", () => {
  it("retries once with a rebuilt pool when connection acquisition times out", async () => {
    const connector = new DamengConnector();
    const release = vi.fn().mockResolvedValue(undefined);
    const stalePool = {
      getConnection: vi.fn(() => new Promise(() => undefined)),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const rebuiltPool = {
      getConnection: vi.fn().mockResolvedValue({ release }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (connector as any).pool = stalePool;
    (connector as any).connectionConfig = { poolAlias: "test" };
    (connector as any).connectionTimeoutMs = 1;
    (connector as any).closePoolQuietly = vi.fn().mockResolvedValue(undefined);
    (connector as any).ensurePool = vi.fn(async () => {
      if (!(connector as any).pool) {
        (connector as any).pool = rebuiltPool;
      }
    });

    const result = await (connector as any).withConnection(async () => "ok");

    expect(result).toBe("ok");
    expect(stalePool.getConnection).toHaveBeenCalledTimes(1);
    expect(rebuiltPool.getConnection).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retries connect when the initial direct connection is reset", async () => {
    const connector = new DamengConnector();
    const pool = {
      getConnection: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createPool = vi.spyOn(dmdb, "createPool").mockResolvedValue(pool as any);
    const validateDirectConnection = vi
      .fn()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValue(undefined);

    (connector as any).validateDirectConnection = validateDirectConnection;
    (connector as any).withConnection = vi.fn().mockResolvedValue(undefined);
    (connector as any).closeRegisteredPool = vi.fn().mockResolvedValue(undefined);
    (connector as any).delay = vi.fn().mockResolvedValue(undefined);

    await connector.connect("dameng://SYSDBA:password@localhost:5236/SYSDBA");

    expect(validateDirectConnection).toHaveBeenCalledTimes(2);
    expect(createPool).toHaveBeenCalledTimes(1);
    createPool.mockRestore();
  });
});
