import { API_URL } from '../config';

export interface GateStatusItem {
  gateId: number;
  lcNumber: string;
  isOnline: boolean;
  deviceStatus: 'ONLINE' | 'OFFLINE';
  lastSeenAt: string | null;
  hasMaster: boolean;
  mastersCount: number;
}

export interface LCGatesCachePayload {
  schemaVersion: number;
  gates: any[];
  scopeGroups: any[];
  etag: string | null;
  lastSyncedAt: string;
  gatesSyncedAt?: string;
  scopeGroupsSyncedAt?: string;
  hierarchySyncedAt?: string;
  isOutdated?: boolean;
}

class LCGatesWebCacheService {
  private static readonly SCHEMA_VERSION = 2;

  // Cache TTL Configuration
  public static readonly GATE_METADATA_TTL_MS = 15 * 60 * 1000; // 15 min
  public static readonly SCOPE_GROUPS_TTL_MS = 30 * 60 * 1000;  // 30 min
  public static readonly HIERARCHY_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
  public static readonly DEVICE_STATUS_TTL_MS = 45 * 1000;        // 45 seconds

  private memoryCache = new Map<string, LCGatesCachePayload>();
  private statusCache = new Map<number, GateStatusItem>();
  private inFlightDirectory = new Map<string, Promise<LCGatesCachePayload | null>>();
  private inFlightStatus: Promise<Map<number, GateStatusItem>> | null = null;
  private lastStatusVerifiedAt: string | null = null;

  private getStorageKey(userId: string): string {
    return `lc_gates_v${LCGatesWebCacheService.SCHEMA_VERSION}_${userId.trim()}`;
  }

  // Check if gate metadata is within 15-minute TTL
  public isGateMetadataFresh(userId: string): boolean {
    const cached = this.memoryCache.get(userId) || this.getCachedDirectory(userId);
    if (!cached || !cached.etag) return false;
    const time = new Date(cached.gatesSyncedAt || cached.lastSyncedAt).getTime();
    return Date.now() - time < LCGatesWebCacheService.GATE_METADATA_TTL_MS;
  }

  // Check if scope groups are within 30-minute TTL
  public isScopeGroupsFresh(userId: string): boolean {
    const cached = this.memoryCache.get(userId) || this.getCachedDirectory(userId);
    if (!cached) return false;
    const time = new Date(cached.scopeGroupsSyncedAt || cached.lastSyncedAt).getTime();
    return Date.now() - time < LCGatesWebCacheService.SCOPE_GROUPS_TTL_MS;
  }

  // Check if device status is within 45-second TTL
  public isDeviceStatusFresh(): boolean {
    if (!this.lastStatusVerifiedAt || this.statusCache.size === 0) return false;
    const time = new Date(this.lastStatusVerifiedAt).getTime();
    return Date.now() - time < LCGatesWebCacheService.DEVICE_STATUS_TTL_MS;
  }

  // Synchronous read for instant paint (< 20ms)
  public getMemoryCache(userId: string): LCGatesCachePayload | null {
    return this.memoryCache.get(userId) || null;
  }

  public getGateStatus(gateId: number): GateStatusItem | undefined {
    return this.statusCache.get(gateId);
  }

  public getAllStatuses(): Map<number, GateStatusItem> {
    return new Map(this.statusCache);
  }

  public getLastStatusVerifiedAt(): string | null {
    return this.lastStatusVerifiedAt;
  }

  // Persistent disk retrieval with corruption safeguard
  public getCachedDirectory(userId: string): LCGatesCachePayload | null {
    if (this.memoryCache.has(userId)) return this.memoryCache.get(userId)!;
    try {
      const raw = localStorage.getItem(this.getStorageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed?.schemaVersion === LCGatesWebCacheService.SCHEMA_VERSION &&
          Array.isArray(parsed.gates)
        ) {
          this.memoryCache.set(userId, parsed);
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[LCGatesWebCacheService] Corrupted localStorage, resetting:', e);
      this.hardClear(userId);
    }
    return null;
  }

  // Deduplicated synchronization with safe HTTP 304 handling and parallel scope fetching
  public async syncDirectory(
    userId: string,
    token: string,
    forceReload = false
  ): Promise<LCGatesCachePayload | null> {
    // TTL Check: Avoid redundant network requests if cache is fresh and reload not forced
    const cached = this.getCachedDirectory(userId);
    if (!forceReload && cached && this.isGateMetadataFresh(userId) && this.isScopeGroupsFresh(userId)) {
      cached.isOutdated = false;
      return cached;
    }

    if (this.inFlightDirectory.has(userId)) {
      return this.inFlightDirectory.get(userId)!;
    }

    const promise = (async () => {
      const currentCached = this.getCachedDirectory(userId);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      if (currentCached?.etag && !forceReload) {
        headers['If-None-Match'] = currentCached.etag;
      }

      try {
        // Parallel requests for Scope Groups and Gates
        const [scopeRes, groupsRes, gatesRes] = await Promise.all([
          fetch(`${API_URL}/api/v1/scope-groups/my-scope`, { headers }).catch(() => null),
          fetch(`${API_URL}/api/v1/scope-groups`, { headers }).catch(() => null),
          fetch(`${API_URL}/api/v1/lcgate`, { headers }),
        ]);

        let resolvedGroups = currentCached?.scopeGroups || [];
        const now = new Date().toISOString();
        try {
          let myGroups: any[] = [];
          if (scopeRes && scopeRes.ok) {
            const scopeData = await scopeRes.json();
            myGroups = scopeData.allScopeGroups || scopeData.scopeGroups || [];
          }
          if (groupsRes && groupsRes.ok) {
            const allGroups = await groupsRes.json();
            if (Array.isArray(allGroups) && allGroups.length > 0) {
              resolvedGroups = allGroups;
            } else if (myGroups.length > 0) {
              resolvedGroups = myGroups;
            }
          } else if (myGroups.length > 0) {
            resolvedGroups = myGroups;
          }
        } catch (_) {}

        // SAFE HTTP 304 HANDLING: Never call res.json() on 304!
        if (gatesRes.status === 304 && currentCached) {
          currentCached.lastSyncedAt = now;
          currentCached.gatesSyncedAt = now;
          currentCached.scopeGroupsSyncedAt = now;
          currentCached.isOutdated = false;
          if (resolvedGroups.length > 0) {
            currentCached.scopeGroups = resolvedGroups;
          }
          this.persist(userId, currentCached);
          return currentCached;
        }

        if (gatesRes.ok) {
          const freshGates = await gatesRes.json();
          const freshPayload: LCGatesCachePayload = {
            schemaVersion: LCGatesWebCacheService.SCHEMA_VERSION,
            gates: Array.isArray(freshGates) ? freshGates : [],
            scopeGroups: resolvedGroups,
            etag: gatesRes.headers.get('etag'),
            lastSyncedAt: now,
            gatesSyncedAt: now,
            scopeGroupsSyncedAt: now,
            hierarchySyncedAt: now,
            isOutdated: false,
          };
          this.memoryCache.set(userId, freshPayload);
          this.persist(userId, freshPayload);
          return freshPayload;
        }

        // Server error status: preserve cache, mark outdated
        if (currentCached) {
          currentCached.isOutdated = true;
          this.persist(userId, currentCached);
          return currentCached;
        }
      } catch (err) {
        console.warn('[LCGatesWebCacheService] Background sync failed, using cached data:', err);
        if (currentCached) {
          currentCached.isOutdated = true;
          this.persist(userId, currentCached);
          return currentCached;
        }
      }
      return currentCached;
    })();

    this.inFlightDirectory.set(userId, promise);
    promise.finally(() => this.inFlightDirectory.delete(userId));
    return promise;
  }

  // Independent Lightweight Device Status Synchronization
  public async syncStatusSummary(token: string, forceReload = false): Promise<Map<number, GateStatusItem>> {
    if (!forceReload && this.isDeviceStatusFresh()) {
      return new Map(this.statusCache);
    }

    if (this.inFlightStatus) {
      return this.inFlightStatus;
    }

    const promise = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/lcgate/status-summary`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.statuses)) {
            data.statuses.forEach((item: any) => {
              this.statusCache.set(item.gateId, item);
            });
            this.lastStatusVerifiedAt = data.verifiedAt || new Date().toISOString();
          }
        }
      } catch (e) {
        console.warn('[LCGatesWebCacheService] Status summary sync error:', e);
      }
      return new Map(this.statusCache);
    })();

    this.inFlightStatus = promise;
    promise.finally(() => {
      this.inFlightStatus = null;
    });
    return promise;
  }

  // Invalidation Mode 1: Patch an individual gate record
  public patchGate(userId: string, updatedGate: any): void {
    const cached = this.getCachedDirectory(userId);
    if (!cached) return;

    const list = [...cached.gates];
    const idx = list.findIndex((g) => g.id === updatedGate.id);
    if (idx !== -1) {
      list[idx] = updatedGate;
    } else {
      list.unshift(updatedGate);
    }

    cached.gates = list;
    this.persist(userId, cached);
  }

  // Invalidation Mode 1: Remove an individual gate
  public removeGate(userId: string, gateId: number): void {
    const cached = this.getCachedDirectory(userId);
    if (!cached) return;

    cached.gates = cached.gates.filter((g) => g.id !== gateId);
    this.persist(userId, cached);
  }

  // Invalidation Mode 2: Mark directory stale (clears ETag and resets sync time to force revalidation)
  public markStale(userId: string): void {
    const cached = this.getCachedDirectory(userId);
    if (cached) {
      cached.etag = null;
      cached.gatesSyncedAt = new Date(0).toISOString();
      cached.scopeGroupsSyncedAt = new Date(0).toISOString();
      this.persist(userId, cached);
    }
  }

  // Invalidation Mode 3: Hard Clear on logout or account switch
  public hardClear(userId: string): void {
    this.memoryCache.delete(userId);
    this.statusCache.clear();
    this.lastStatusVerifiedAt = null;
    try {
      localStorage.removeItem(this.getStorageKey(userId));
    } catch (_) {}
  }

  // Clear all LC Gate caches on user logout
  public clearAllUserCaches(): void {
    this.memoryCache.clear();
    this.statusCache.clear();
    this.lastStatusVerifiedAt = null;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('lc_gates_v')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }

  private persist(userId: string, data: LCGatesCachePayload): void {
    this.memoryCache.set(userId, data);
    try {
      localStorage.setItem(this.getStorageKey(userId), JSON.stringify(data));
    } catch (e) {
      console.warn(
        '[LCGatesWebCacheService] LocalStorage quota exceeded, caching in memory only:',
        e
      );
    }
  }
}

export const lcGatesCacheService = new LCGatesWebCacheService();

