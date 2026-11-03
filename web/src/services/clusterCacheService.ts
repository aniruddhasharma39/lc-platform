/**
 * ClusterCacheService
 *
 * Dedicated Two-Level Intelligent Caching Service for React Web Cluster Section:
 * - Level 1: In-memory Map for instantaneous (<5ms) synchronous UI rendering upon revisit.
 * - Level 2: Persistent localStorage with quota protection, corruption safeguards, and user isolation.
 * - HTTP 304 Not Modified integration with conditional If-None-Match headers.
 * - Stale-while-revalidate lifecycle: renders cached gates instantly, revalidates in background.
 * - Safe user isolation and automatic cleanup on logout or account switch.
 */

export interface ClusterCacheEntry {
  userId: string | number;
  scopeKey: string; // 'ALL' or specific scopeGroupId
  gates: any[];
  etag: string | null;
  cachedAt: number;
  verifiedAt: number;
  schemaVersion: number;
}

export interface ReferenceDataCacheEntry {
  zones: string[];
  divisionsByZone: Record<string, string[]>;
  etag: string | null;
  verifiedAt: number;
}

const SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'lc_cluster_v1_';
const REF_STORAGE_KEY = 'lc_cluster_ref_v1';
const MAX_MEM_ENTRIES = 25;
const MAX_STORAGE_ENTRIES = 10;
const FRESHNESS_TTL_MS = 60 * 1000; // 60s stale-threshold for telemetry connectivity

class ClusterCacheService {
  private memCache = new Map<string, ClusterCacheEntry>();
  private refMemCache: ReferenceDataCacheEntry | null = null;

  private makeKey(userId: string | number, scopeKey: string): string {
    const s = String(scopeKey || 'ALL').trim().toLowerCase();
    return `u${userId}_s${s}`;
  }

  private makeStorageKey(userId: string | number, scopeKey: string): string {
    return `${STORAGE_PREFIX}${this.makeKey(userId, scopeKey)}`;
  }

  /**
   * Retrieves cached Cluster gates. Checks L1 Memory first, then falls back to L2 localStorage.
   */
  public get(userId: string | number, scopeKey: string): ClusterCacheEntry | null {
    const key = this.makeKey(userId, scopeKey);

    // 1. Level 1: In-Memory Cache
    const mem = this.memCache.get(key);
    if (mem && mem.userId === userId) {
      return JSON.parse(JSON.stringify(mem));
    }

    // 2. Level 2: Persistent localStorage
    try {
      const storageKey = this.makeStorageKey(userId, scopeKey);
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;

      const parsed: ClusterCacheEntry = JSON.parse(raw);
      if (
        !parsed ||
        parsed.schemaVersion !== SCHEMA_VERSION ||
        String(parsed.userId) !== String(userId) ||
        !Array.isArray(parsed.gates)
      ) {
        localStorage.removeItem(storageKey);
        return null;
      }

      // Populate L1 cache for subsequent instant access
      this.memCache.set(key, parsed);
      return JSON.parse(JSON.stringify(parsed));
    } catch (err) {
      console.warn('[ClusterCacheService] Corrupted storage read, resetting:', err);
      try {
        localStorage.removeItem(this.makeStorageKey(userId, scopeKey));
      } catch (_) {}
      return null;
    }
  }

  /**
   * Saves or updates Cluster gates in L1 memory and L2 localStorage.
   */
  public set(
    userId: string | number,
    scopeKey: string,
    gates: any[],
    etag: string | null
  ): void {
    const key = this.makeKey(userId, scopeKey);
    const now = Date.now();

    const entry: ClusterCacheEntry = {
      userId,
      scopeKey: String(scopeKey || 'ALL'),
      gates: JSON.parse(JSON.stringify(gates)),
      etag,
      cachedAt: now,
      verifiedAt: now,
      schemaVersion: SCHEMA_VERSION,
    };

    // 1. Store in L1 Memory Cache with LRU cap
    if (this.memCache.size >= MAX_MEM_ENTRIES) {
      const oldest = this.memCache.keys().next().value;
      if (oldest) this.memCache.delete(oldest);
    }
    this.memCache.set(key, entry);

    // 2. Store in L2 Persistent Storage with Quota Defense
    try {
      const storageKey = this.makeStorageKey(userId, scopeKey);
      localStorage.setItem(storageKey, JSON.stringify(entry));
      this.pruneOldStorageEntries();
    } catch (err: any) {
      if (err?.name === 'QuotaExceededError' || err?.code === 22) {
        console.warn('[ClusterCacheService] Storage quota exceeded, evicting old entries.');
        this.clearAllClusterStorage();
        try {
          localStorage.setItem(this.makeStorageKey(userId, scopeKey), JSON.stringify(entry));
        } catch (_) {}
      }
    }
  }

  /**
   * Updates only the verified timestamp and ETag when HTTP 304 is returned.
   */
  public touchVerified(userId: string | number, scopeKey: string, etag?: string): void {
    const existing = this.get(userId, scopeKey);
    if (existing) {
      existing.verifiedAt = Date.now();
      if (etag) existing.etag = etag;
      this.set(userId, scopeKey, existing.gates, existing.etag);
    }
  }

  /**
   * Reference Data (Zones and Divisions) Caching
   */
  public getReferenceData(): ReferenceDataCacheEntry | null {
    if (this.refMemCache) return this.refMemCache;
    try {
      const raw = localStorage.getItem(REF_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.zones)) {
        this.refMemCache = parsed;
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  public setReferenceData(
    zones: string[],
    divisionsByZone: Record<string, string[]>,
    etag: string | null
  ): void {
    const entry: ReferenceDataCacheEntry = {
      zones,
      divisionsByZone,
      etag,
      verifiedAt: Date.now(),
    };
    this.refMemCache = entry;
    try {
      localStorage.setItem(REF_STORAGE_KEY, JSON.stringify(entry));
    } catch (_) {}
  }

  /**
   * Updates or removes a gate across all cached scopes for this user upon mutation.
   */
  public invalidateGateAcrossCache(userId: string | number, gateId: number): void {
    const userPrefix = `u${userId}_`;
    for (const [k, entry] of this.memCache.entries()) {
      if (k.startsWith(userPrefix)) {
        entry.gates = entry.gates.filter((g: any) => g.id !== gateId);
        entry.etag = null; // Clear ETag to ensure subsequent fetch revalidates
        try {
          const storageKey = `${STORAGE_PREFIX}${k}`;
          localStorage.setItem(storageKey, JSON.stringify(entry));
        } catch (_) {}
      }
    }
  }

  /**
   * Invalidates cached entries after gate mutations (add, edit, delete).
   */
  public invalidate(userId?: string | number, scopeKey?: string): void {
    if (userId !== undefined && scopeKey !== undefined) {
      const key = this.makeKey(userId, scopeKey);
      this.memCache.delete(key);
      try {
        localStorage.removeItem(this.makeStorageKey(userId, scopeKey));
      } catch (_) {}
      return;
    }

    if (userId !== undefined) {
      this.clearUser(userId);
      return;
    }

    this.clearAll();
  }

  /**
   * Cleans all cache for a user upon logout.
   */
  public clearUser(userId: string | number): void {
    for (const [k, v] of this.memCache.entries()) {
      if (String(v.userId) === String(userId)) {
        this.memCache.delete(k);
      }
    }

    try {
      const prefix = `${STORAGE_PREFIX}u${userId}_`;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }

  public clearAll(): void {
    this.memCache.clear();
    this.refMemCache = null;
    this.clearAllClusterStorage();
  }

  private clearAllClusterStorage(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(STORAGE_PREFIX) || k === REF_STORAGE_KEY)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }

  private pruneOldStorageEntries(): void {
    try {
      const clusterKeys: { key: string; cachedAt: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          try {
            const item = JSON.parse(localStorage.getItem(k) || '{}');
            clusterKeys.push({ key: k, cachedAt: item.cachedAt || 0 });
          } catch (_) {
            clusterKeys.push({ key: k, cachedAt: 0 });
          }
        }
      }

      if (clusterKeys.length > MAX_STORAGE_ENTRIES) {
        clusterKeys.sort((a, b) => a.cachedAt - b.cachedAt);
        const toDelete = clusterKeys.slice(0, clusterKeys.length - MAX_STORAGE_ENTRIES);
        toDelete.forEach((entry) => localStorage.removeItem(entry.key));
      }
    } catch (_) {}
  }

  /**
   * Helper to determine if cached data is older than the freshness threshold.
   */
  public isStale(entry: ClusterCacheEntry): boolean {
    return Date.now() - entry.verifiedAt > FRESHNESS_TTL_MS;
  }
}

export const clusterCacheService = new ClusterCacheService();
