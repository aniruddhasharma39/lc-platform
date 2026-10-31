import { prisma } from './prisma';

/**
 * Atomic Monotonic Directory Revision Manager
 * Uses PostgreSQL row-level locks on AppSetting to guarantee that concurrent mutations
 * atomically increment an integer counter without losing updates.
 *
 * Scoping rules:
 * - Scoped gate mutations bump ONLY the affected scope groups.
 * - Global mutations (unassigned gates, global role/scope modifications) bump DIRECTORY_GLOBAL_REVISION.
 * - Developers check both global revision and their accessible scopes.
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
    const validScopeIds = Array.from(new Set(scopeGroupIds.filter((id) => id && !isNaN(id))));

    // If change is explicitly global or entity has no scope assigned (unassigned gate)
    if (isGlobalChange || validScopeIds.length === 0) {
      await atomicIncrement(client, 'DIRECTORY_GLOBAL_REVISION');
    }

    // Bump affected scope groups
    for (const sgId of validScopeIds) {
      await atomicIncrement(client, `DIRECTORY_SCOPE_REVISION_${sgId}`);
    }
  } catch (error) {
    console.error('[RevisionManager] Error bumping directory revision:', error);
  }
}

/**
 * Calculates a lightweight, deterministic revision token for a user based on
 * their assigned scope hierarchy + global directory state.
 * Runs in ~1-2ms using indexed AppSetting lookups.
 */
export async function getDirectoryRevisionToken(
  userId: number,
  assignedScopeGroupIds: number[] = [],
  isDeveloper = false
): Promise<string> {
  try {
    const keys = ['DIRECTORY_GLOBAL_REVISION'];
    for (const sgId of assignedScopeGroupIds) {
      keys.push(`DIRECTORY_SCOPE_REVISION_${sgId}`);
    }

    const settings = await prisma.appSetting.findMany({
      where: { key: { in: keys } },
      select: { key: true, value: true },
    });

    const settingMap = new Map(settings.map((s) => [s.key, s.value]));
    const globalRev = settingMap.get('DIRECTORY_GLOBAL_REVISION') || '1';
    const scopeRevs = assignedScopeGroupIds
      .map((id) => settingMap.get(`DIRECTORY_SCOPE_REVISION_${id}`) || '0')
      .join('-');

    return `W/"rev-u${userId}-g${globalRev}-s${scopeRevs}"`;
  } catch (error) {
    console.error('[RevisionManager] Error reading revision token, fallback generated:', error);
    return `W/"rev-u${userId}-${Date.now()}"`;
  }
}
