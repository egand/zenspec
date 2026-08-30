/**
 * Cloud Tunneling & Remote Dev Sharing helper for Zen AXI
 * Supports Cloudflare Quick Tunnels (cloudflared) and LAN tokenized sharing
 */
import { spawn } from "node:child_process";
import os from "node:os";

export interface TunnelInfo {
  url: string;
  type: "cloudflared" | "lan";
  close?: () => void;
}

export function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.family === "IPv4") {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

export async function startTunnel(port: number, token?: string): Promise<TunnelInfo> {
  const tokenQuery = token ? `?token=${token}` : "";

  // 1. Try launching cloudflared quick tunnel
  try {
    const cf = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tunnelPromise = new Promise<TunnelInfo>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          cf.kill();
          reject(new Error("Cloudflared timeout"));
        }
      }, 7000);

      const checkOutput = (data: Buffer) => {
        const str = data.toString();
        const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            url: match[0] + tokenQuery,
            type: "cloudflared",
            close: () => cf.kill(),
          });
        }
      };

      cf.stdout?.on("data", checkOutput);
      cf.stderr?.on("data", checkOutput);
      cf.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    return await tunnelPromise;
  } catch {
    // 2. Fallback to LAN IP with token
    const lanIp = getLanIp();
    return {
      url: `http://${lanIp}:${port}${tokenQuery}`,
      type: "lan",
    };
  }
}
