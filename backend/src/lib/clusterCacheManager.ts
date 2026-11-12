import crypto from 'crypto';

/**
 * Cluster Cache Manager
 *
 * Dedicated in-memory L1 cache manager for the LC Platform Cluster / Gates section.
 * Provides:
 * - Canonical cache key normalization
 * - Fast LRU in-memory storage with configurable max entries and memory bounds
 * - TTL-based expiration (e.g. 30s-60s for telemetry heartbeat freshness)
 * - Scope-aware and user-aware invalidation hooks
 * - Deep freeze / immutability protection to prevent in-memory mutation leakage
 * - Multi-instance synchronization via shared PostgreSQL directory revisions
 */

interface CacheEntry<T> {
  key: string;
  data: T;
  etag: string;
  createdAt: number;
  expiresAt: number;
  userId: number;
  scopeGroupIds: number[];
  isDeveloper: boolean;
  byteSize: number;
}

export interface ClusterCacheStats {
  size: number;
  maxEntries: number;
  currentMemoryBytes: number;
  maxMemoryBytes: number;
  hits: number;
  misses: number;
  invalidations: number;
}

/**
 * Deep freezes an object recursively to guarantee total in-memory immutability.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

class ClusterCacheManager {
  private cache = new Map<string, CacheEntry<any>>();
  private maxEntries = 500;
  private maxMemoryBytes = 50 * 1024 * 1024; // 50MB default configurable memory budget
  private currentMemoryBytes = 0;
  private defaultTtlMs = 60 * 1000; // 60 seconds default (matches telemetry heartbeat grace)
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(
    maxEntries = 500,
    defaultTtlMs = 60 * 1000,
    maxMemoryBytes = process.env.CLUSTER_CACHE_MAX_BYTES
      ? parseInt(process.env.CLUSTER_CACHE_MAX_BYTES, 10)
      : 50 * 1024 * 1024
  ) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.maxMemoryBytes = maxMemoryBytes;
  }

  /**
   * Generates a deterministic, canonical cache key for a cluster query.
   * Ensures distinct cache identities across users, roles, scope query parameters,
   * directory revisions, and telemetry freshness time-buckets.
   */
  public generateKey(params: {
    userId: number;
    userRole: string;
    directoryRevision: string;
    scopeGroupId?: string | null;
    directOnly?: string | null;
    configuredOnly?: string | null;
    telemetryBucket?: number | null;
  }): string {
    const roleKey = params.userRole.trim().toLowerCase() === 'developer' ? 'DEV' : 'USER';

    // Normalize scope query parameter:
    // - 'all' or empty string
    // - numeric scope group ID (e.g. '5')
    let normScope = 'ALL';
    if (params.scopeGroupId && typeof params.scopeGroupId === 'string') {
      const trimmed = params.scopeGroupId.trim().toLowerCase();
      if (trimmed !== '' && trimmed !== 'all') {
        const num = parseInt(trimmed, 10);
        normScope = !isNaN(num) ? String(num) : trimmed;
      }
    }

    const normDirect = params.directOnly === 'true' || params.directOnly === '1' ? 'DIR' : 'REC';
    const normConfiguredOnly = params.configuredOnly === 'true' || params.configuredOnly === '1' ? 'CFG' : 'ALL';

    // Transition-aware stable key: if telemetryBucket is omitted, generates a stable key
    // that remains identical until directory revision bumps or transition TTL expires.
    const tbPart = params.telemetryBucket !== undefined && params.telemetryBucket !== null
      ? `:tb[${params.telemetryBucket}]`
      : '';

    return `cluster:u${params.userId}:r${roleKey}:s[${normScope}]:d[${normDirect}]:c[${normConfiguredOnly}]${tbPart}:rev[${params.directoryRevision}]`;
  }

  /**
   * Generates a canonical HTTP ETag matching the exact response identity.
   */
  public generateETag(params: {
    userId: number;
    userRole: string;
    directoryRevision: string;
    scopeGroupId?: string | null;
    directOnly?: string | null;
    configuredOnly?: string | null;
    telemetryBucket?: number | null;
  }): string {
    const key = this.generateKey(params);
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return `W/"cl-${hash}"`;
  }

  /**
   * Actively purges expired entries from the cache to keep memory usage bounded.
   */
  public purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [k, v] of this.cache.entries()) {
      if (now > v.expiresAt) {
        this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - v.byteSize);
        this.cache.delete(k);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Retrieves an entry from cache. Checks TTL, enforces LRU order,
   * and returns an isolated clone to ensure caller safety.
   */
  public get<T>(key: string): { data: T; etag: string; expiresAt: number } | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL expiry check
    if (Date.now() > entry.expiresAt) {
      this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - entry.byteSize);
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    // Return structured clone to prevent caller mutations from affecting cache
    return {
      data: JSON.parse(JSON.stringify(entry.data)),
      etag: entry.etag,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Stores an entry into the cache with dual LRU eviction (entry count + memory budget in bytes).
   * Automatically enforces deep freezing and safe handling of oversized payloads.
   */
  public set<T>(
    key: string,
    data: T,
    etag: string,
    meta: {
      userId: number;
      scopeGroupIds?: number[];
      isDeveloper?: boolean;
      ttlMs?: number;
    }
  ): void {
    // If ttlMs is explicitly 0 or negative, do not cache (boundary transition reached)
    if (meta.ttlMs !== undefined && meta.ttlMs <= 0) {
      return;
    }

    // 1. Purge expired entries first to recover memory
    this.purgeExpired();

    const now = Date.now();
    const ttl = meta.ttlMs !== undefined && meta.ttlMs > 0 ? meta.ttlMs : this.defaultTtlMs;

    // Deep copy and deep freeze data before storing to guarantee immutability
    const immutableData = deepFreeze(JSON.parse(JSON.stringify(data)));
    const payloadBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    const entryBytes = payloadBytes + Buffer.byteLength(key, 'utf8') + 256; // metadata overhead

    // Safe handling of oversized payloads: if single payload exceeds memory budget, do not cache
    if (entryBytes > this.maxMemoryBytes) {
      return;
    }

    // Remove existing entry for the same key if updating
    const existing = this.cache.get(key);
    if (existing) {
      this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - existing.byteSize);
      this.cache.delete(key);
    }

    // 2. Evict oldest if at capacity (LRU) or memory budget exceeded
    while (
      (this.cache.size >= this.maxEntries || this.currentMemoryBytes + entryBytes > this.maxMemoryBytes) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldestEntry = this.cache.get(oldestKey);
        if (oldestEntry) {
          this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - oldestEntry.byteSize);
        }
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      key,
      data: immutableData,
      etag,
      createdAt: now,
      expiresAt: now + ttl,
      userId: meta.userId,
      scopeGroupIds: meta.scopeGroupIds || [],
      isDeveloper: meta.isDeveloper || false,
      byteSize: entryBytes,
    });
    this.currentMemoryBytes += entryBytes;
  }

  /**
   * Invalidates cached entries associated with specific scope groups.
   */
  public invalidateScopeGroups(scopeGroupIds: number[]): void {
    if (scopeGroupIds.length === 0) {
      this.invalidateAll();
      return;
    }

    const scopeSet = new Set(scopeGroupIds);
    let count = 0;

    for (const [k, v] of this.cache.entries()) {
      if (v.isDeveloper || v.scopeGroupIds.some((id) => scopeSet.has(id))) {
        this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - v.byteSize);
        this.cache.delete(k);
        count++;
      }
    }

    this.invalidations += count;
  }

  /**
   * Invalidates all cached entries for a specific user.
   */
  public invalidateUser(userId: number): void {
    let count = 0;
    for (const [k, v] of this.cache.entries()) {
      if (v.userId === userId) {
        this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - v.byteSize);
        this.cache.delete(k);
        count++;
      }
    }
    this.invalidations += count;
  }

  /**
   * Complete cache purge (e.g. global role change or global revision bump).
   */
  public invalidateAll(): void {
    this.invalidations += this.cache.size;
    this.cache.clear();
    this.currentMemoryBytes = 0;
  }

  /**
   * Alias for invalidateAll
   */
  public clear(): void {
    this.invalidateAll();
  }

  /**
   * Returns cache runtime metrics including byte memory utilization.
   */
  public getStats(): ClusterCacheStats {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      currentMemoryBytes: this.currentMemoryBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
    };
  }
}

export const clusterCacheManager = new ClusterCacheManager();
