import { describe, it, expect } from "vitest";
import { getLanIp, startTunnel } from "../src/tunnel.js";

describe("Tunnel & LAN Sharing", () => {
  it("resolves a non-empty LAN or loopback IP address", () => {
    const ip = getLanIp();
    expect(ip).toBeDefined();
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
    expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it("returns LAN sharing URL with port and token parameter", async () => {
    const port = 4388;
    const token = "secure-token-123";
    const tunnel = await startTunnel(port, token);

    expect(tunnel.url).toBeDefined();
    expect(tunnel.url).toContain(String(port));
    expect(tunnel.url).toContain("token=secure-token-123");
    expect(["cloudflared", "lan"]).toContain(tunnel.type);
  });
});
