import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import YAML from "yaml";
import {
  compactAnalyticsParams,
  createQueuedAnalytics,
  errorCodeFromUnknown,
  readAnalyticsClientId,
  type AnalyticsAppEnv,
  type AnalyticsParams,
} from "../cli/analytics.js";
import { asRecord, defaultConfigPaths, expandHome, optionalString } from "../cli/config.js";

/** Matches Desktop memory lifecycle event names (`memory_desktop_*`). */
export const MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS = {
  addStarted: "memory_desktop_add_started",
  addSucceeded: "memory_desktop_add_succeeded",
  addFailed: "memory_desktop_add_failed",
} as const;

export const MEMORY_DESKTOP_ADD_ENTRYPOINT = "memmy-desktop";
export const MEMORY_DESKTOP_ADD_STORAGE_BACKEND = "memmy-memory";
export const MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN = "agent_source_scan";
export const MEMORY_DESKTOP_ADD_LAYER_L1 = "L1";

export type MemoryDesktopAddScanMode = "initial_subset" | "incremental" | "full";

const MEMORY_ADD_ANALYTICS_SOURCE = "memmy-agent";

export type MemoryDesktopAddAnalytics = {
  trackAddStarted: (input: MemoryDesktopScanAddBaseInput) => void;
  trackAddSucceeded: (input: MemoryDesktopScanAddBaseInput & {
    durationMs: number;
    storedCount: number;
  }) => void;
  trackAddFailed: (input: MemoryDesktopScanAddBaseInput & {
    durationMs: number;
    error?: unknown;
    errorCode?: string;
  }) => void;
  flush: () => Promise<void>;
};

export type MemoryDesktopScanAddBaseInput = {
  adapterId: string;
  /** Present for agent-source scan/import paths; omitted when unavailable. */
  scanMode?: MemoryDesktopAddScanMode;
  conversationId?: string | null;
  turnId?: string | null;
};

export function hashAnalyticsId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildMemoryDesktopScanAddParams(input: MemoryDesktopScanAddBaseInput): AnalyticsParams {
  const sessionIdHash = hashAnalyticsId(input.conversationId);
  const turnIdHash = hashAnalyticsId(input.turnId);
  return compactAnalyticsParams({
    entrypoint: MEMORY_DESKTOP_ADD_ENTRYPOINT,
    adapter_id: input.adapterId,
    storage_backend: MEMORY_DESKTOP_ADD_STORAGE_BACKEND,
    mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
    layer: MEMORY_DESKTOP_ADD_LAYER_L1,
    ...(input.scanMode ? { scan_mode: input.scanMode } : {}),
    ...(sessionIdHash ? { session_id_hash: sessionIdHash } : {}),
    ...(turnIdHash ? { turn_id_hash: turnIdHash } : {}),
  });
}

type SourceTurnAddAnalytics = Pick<MemoryDesktopAddAnalytics, "trackAddStarted" | "trackAddSucceeded" | "trackAddFailed">;

/** Only a newly stored native turn counts as an add; existing, rejected, pending and conflict results do not. */
export function trackSourceTurnAddStored(
  analytics: SourceTurnAddAnalytics | undefined,
  base: MemoryDesktopScanAddBaseInput,
  startedAt: number,
  result: { status: string; result?: { l1MemoryIds?: readonly string[] } }
): void {
  if (!analytics || result.status !== "stored") return;
  analytics.trackAddStarted(base);
  analytics.trackAddSucceeded({
    ...base,
    durationMs: Date.now() - startedAt,
    storedCount: result.result?.l1MemoryIds?.length ?? 0,
  });
}

export function trackSourceTurnAddFailed(
  analytics: SourceTurnAddAnalytics | undefined,
  base: MemoryDesktopScanAddBaseInput,
  startedAt: number,
  error: unknown
): void {
  if (!analytics) return;
  analytics.trackAddStarted(base);
  analytics.trackAddFailed({ ...base, durationMs: Date.now() - startedAt, error });
}

export type AnalyticsIdentityReader = {
  getUserId: () => string | null;
  getUserMode: () => string | null;
};

/**
 * Reads the Desktop account projection (`app.cloudUuid`, `app.userId`, `app.userMode`) from the
 * Memmy config so Memory-side events carry the same identity as backend events. The file is
 * re-read when it changes because login and logout rewrite it while Memory keeps running.
 */
export function createConfigAnalyticsIdentity(configPath?: string): AnalyticsIdentityReader {
  const path = configPath ? expandHome(configPath) : defaultConfigPaths()[0];
  let cachedMtimeMs: number | null = null;
  let cached: { userId: string | null; userMode: string | null } = { userId: null, userMode: null };

  const read = () => {
    if (!path) return cached;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      cachedMtimeMs = null;
      cached = { userId: null, userMode: null };
      return cached;
    }
    if (mtimeMs === cachedMtimeMs) return cached;
    try {
      const app = asRecord(asRecord(YAML.parse(readFileSync(path, "utf8"))).app);
      const mode = optionalString(app.userMode);
      cached = {
        userId: optionalString(app.cloudUuid) ? optionalString(app.userId) ?? null : null,
        userMode: mode === "account" || mode === "byok" ? mode : null,
      };
      cachedMtimeMs = mtimeMs;
    } catch {
      cached = { userId: null, userMode: null };
    }
    return cached;
  };

  return {
    getUserId: () => read().userId,
    getUserMode: () => read().userMode,
  };
}

export function createMemoryDesktopAddAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getInstallationId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  appEnv?: AnalyticsAppEnv | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): MemoryDesktopAddAnalytics {
  const queued = createQueuedAnalytics({
    source: MEMORY_ADD_ANALYTICS_SOURCE,
    getClientId: options.getClientId ?? (() => readAnalyticsClientId()),
    getInstallationId: options.getInstallationId,
    getUserId: options.getUserId,
    getUserMode: options.getUserMode,
    appEnv: options.appEnv,
    debugMode: options.debugMode,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });

  return {
    trackAddStarted(input) {
      queued.track(MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addStarted, buildMemoryDesktopScanAddParams(input));
    },
    trackAddSucceeded(input) {
      queued.track(
        MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addSucceeded,
        compactAnalyticsParams({
          ...buildMemoryDesktopScanAddParams(input),
          duration_ms: Math.max(0, Math.trunc(input.durationMs)),
          success: true,
          stored_count: Math.max(0, Math.trunc(input.storedCount)),
        }),
      );
    },
    trackAddFailed(input) {
      queued.track(
        MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addFailed,
        compactAnalyticsParams({
          ...buildMemoryDesktopScanAddParams(input),
          duration_ms: Math.max(0, Math.trunc(input.durationMs)),
          success: false,
          error_code: input.errorCode ?? errorCodeFromUnknown(input.error),
        }),
      );
    },
    flush() {
      return queued.flush();
    },
  };
}
