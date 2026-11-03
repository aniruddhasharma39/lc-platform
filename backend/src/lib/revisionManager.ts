import { prisma } from './prisma';
import { clusterCacheManager } from './clusterCacheManager';

/**
 * Atomic Monotonic Directory Revision Manager (global only; scope groups removed).
 */
async function atomicIncrement(client: any, key: string): Promise<void> {
  await client.$executeRawUnsafe(`
    INSERT INTO "AppSetting" ("key", "value")
    VALUES ('${key}', '1')
    ON CONFLICT ("key") DO UPDATE
    SET "value" = (CAST("AppSetting"."value" AS BIGINT) + 1)::TEXT;
  `);
}

export async function bumpDirectoryRevision(
  scopeGroupIds: number[] = [],
  isGlobalChange = false,
  txClient?: any
): Promise<void> {
  const client = txClient || prisma;
  try {
    await atomicIncrement(client, 'DIRECTORY_GLOBAL_REVISION');
    clusterCacheManager.invalidateAll();
  } catch (error) {
    console.error('[RevisionManager] Error bumping directory revision:', error);
    if (txClient) throw error;
  }
}

export async function getDirectoryRevisionToken(
  userId: number,
  assignedScopeGroupIds: number[] = [],
  isDeveloper = false,
  preloadedSettings?: Array<{ key: string; value: string }>
): Promise<string> {
  try {
    const globalRev = '1';
    let settings: Array<{ key: string; value: string }> = [];
    if (preloadedSettings) {
      settings = preloadedSettings.filter(s => s.key === 'DIRECTORY_GLOBAL_REVISION');
    } else {
      settings = await prisma.appSetting.findMany({
        where: { key: 'DIRECTORY_GLOBAL_REVISION' },
        select: { key: true, value: true },
      });
    }
    const rev = settings[0]?.value || globalRev;
    return `W/"rev-u${userId}-dev${isDeveloper ? 1 : 0}-g${rev}"`;
  } catch (error) {
    console.error('[RevisionManager] Error reading revision token, fallback generated:', error);
    return `W/"rev-u${userId}-${Date.now()}"`;
  }
}