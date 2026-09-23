import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS,
  MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
  buildMemoryDesktopScanAddParams,
  createConfigAnalyticsIdentity,
  createMemoryDesktopAddAnalytics,
  hashAnalyticsId,
} from "../src/server/memory-add-analytics.js";

describe("createConfigAnalyticsIdentity", () => {
  async function withConfig(run: (write: (yaml: string) => void, path: string) => void | Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "memory-add-identity-"));
    const path = join(root, "config.yaml");
    let tick = 1_700_000_000;
    const write = (yaml: string) => {
      writeFileSync(path, yaml);
      tick += 10;
      utimesSync(path, tick, tick);
    };
    try { await run(write, path); } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it("reports the logged-in account id and mode from the Desktop account projection", async () => {
    await withConfig((write, path) => {
      write("app:\n  cloudUuid: cloud-1\n  userId: user-1\n  userMode: account\n");
      const identity = createConfigAnalyticsIdentity(path);
      expect(identity.getUserId()).toBe("user-1");
      expect(identity.getUserMode()).toBe("account");
    });
  });

  it("omits the user id when the account is logged out and follows later config rewrites", async () => {
    await withConfig((write, path) => {
      write("app:\n  userId: stale-user\n  userMode: byok\n");
      const identity = createConfigAnalyticsIdentity(path);
      expect(identity.getUserId()).toBeNull();
      expect(identity.getUserMode()).toBe("byok");
      write("app:\n  cloudUuid: cloud-2\n  userId: user-2\n  userMode: account\n");
      expect(identity.getUserId()).toBe("user-2");
      expect(identity.getUserMode()).toBe("account");
    });
  });

  it("returns no identity when the config is missing or the mode is unknown", async () => {
    await withConfig((write, path) => {
      expect(createConfigAnalyticsIdentity(path).getUserId()).toBeNull();
      write("app:\n  cloudUuid: cloud-1\n  userId: user-1\n  userMode: something-else\n");
      expect(createConfigAnalyticsIdentity(path).getUserMode()).toBeNull();
    });
  });

  it("sends the config identity with desktop add events", async () => {
    await withConfig(async (write, path) => {
      write("app:\n  cloudUuid: cloud-1\n  userId: user-1\n  userMode: account\n");
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const analytics = createMemoryDesktopAddAnalytics({
        ...createConfigAnalyticsIdentity(path),
        getClientId: () => "client-1",
        getInstallationId: () => "install-1",
        baseUrl: "https://example.test",
        fetchImpl,
      });
      analytics.trackAddStarted({ adapterId: "agent-source:codex" });
      await analytics.flush();
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      expect(body.userId).toBe("user-1");
      expect(body.events[0]?.params).toMatchObject({ user_id: "user-1", user_mode: "account" });
    });
  });
});

describe("memory-add-analytics", () => {
  it("hashes ids and builds scan add params with agent_source_scan mode and scan_mode", () => {
    expect(hashAnalyticsId("conv-1")).toHaveLength(16);
    expect(buildMemoryDesktopScanAddParams({
      adapterId: "agent-source:cursor",
      scanMode: "initial_subset",
      conversationId: "conv-1",
      turnId: "cursor:abc",
    })).toEqual({
      entrypoint: "memmy-desktop",
      adapter_id: "agent-source:cursor",
      storage_backend: "memmy-memory",
      mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
      scan_mode: "initial_subset",
      layer: "L1",
      session_id_hash: hashAnalyticsId("conv-1"),
      turn_id_hash: hashAnalyticsId("cursor:abc"),
    });
  });

  it("tracks started/succeeded/failed desktop add events", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const analytics = createMemoryDesktopAddAnalytics({
      getClientId: () => "client-1",
      getInstallationId: () => "install-1",
      getUserId: () => "user-1",
      getUserMode: () => "account",
      appEnv: "dev",
      debugMode: false,
      baseUrl: "https://example.test",
      fetchImpl,
    });

    analytics.trackAddStarted({
      adapterId: "agent-source:cursor",
      scanMode: "full",
      conversationId: "conv-1",
      turnId: "turn-1",
    });
    analytics.trackAddSucceeded({
      adapterId: "agent-source:cursor",
      scanMode: "full",
      conversationId: "conv-1",
      turnId: "turn-1",
      durationMs: 12,
      storedCount: 1,
    });
    analytics.trackAddFailed({
      adapterId: "agent-source:cursor",
      scanMode: "incremental",
      conversationId: "conv-1",
      turnId: "turn-2",
      durationMs: 3,
      error: new Error("boom"),
    });
    await analytics.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ clientId: "client-1", userId: "user-1", installationId: "install-1" });
    const names = body.events.map((event: { eventName: string }) => event.eventName);
    expect(names).toEqual([
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addStarted,
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addSucceeded,
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addFailed,
    ]);
    expect(body.events[0]?.params).toMatchObject({
      user_id: "user-1",
      user_mode: "account",
      source: "memmy-agent",
      mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
      scan_mode: "full",
      adapter_id: "agent-source:cursor",
    });
    expect(body.events[1]?.params).toMatchObject({
      success: true,
      stored_count: 1,
      duration_ms: 12,
      scan_mode: "full",
    });
    expect(body.events[2]?.params).toMatchObject({
      success: false,
      error_code: "boom",
      duration_ms: 3,
      scan_mode: "incremental",
    });
  });
});
