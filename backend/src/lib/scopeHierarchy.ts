import { prisma } from './prisma';

/**
 * Given a list of scope group IDs, recursively fetches all descendant scope group IDs.
 */
export async function getAllDescendantScopeGroupIds(groupIds: number[], client: any = prisma): Promise<number[]> {
  const allIds = new Set<number>(groupIds);
  let currentLevelIds = [...groupIds];

  while (currentLevelIds.length > 0) {
    const children = await client.scopeGroup.findMany({
      where: { parentId: { in: currentLevelIds } },
      select: { id: true }
    });

    const nextIds: number[] = [];
    for (const child of children) {
      if (!allIds.has(child.id)) {
        allIds.add(child.id);
        nextIds.push(child.id);
      }
    }
    currentLevelIds = nextIds;
  }

  return Array.from(allIds);
}

/**
 * Given a list of scope group IDs, recursively fetches all ancestor (parent) scope group IDs up the hierarchy tree.
 */
export async function getAllAncestorScopeGroupIds(groupIds: number[], client: any = prisma): Promise<number[]> {
  const ancestorIds = new Set<number>();
  let currentIds = [...groupIds.filter((id) => id && !isNaN(id))];

  while (currentIds.length > 0) {
    const parents: Array<{ parentId: number | null }> = await client.scopeGroup.findMany({
      where: { id: { in: currentIds } },
      select: { parentId: true }
    });

    const nextIds: number[] = [];
    for (const p of parents) {
      if (p.parentId && !ancestorIds.has(p.parentId)) {
        ancestorIds.add(p.parentId);
        nextIds.push(p.parentId);
      }
    }
    currentIds = nextIds;
  }

  return Array.from(ancestorIds);
}

/**
 * Checks if setting newParentId as parent of groupId would create a circular reference.
 */
export async function wouldCreateCycle(groupId: number, newParentId: number): Promise<boolean> {
  if (groupId === newParentId) return true;
  const descendantIds = await getAllDescendantScopeGroupIds([groupId]);
  return descendantIds.includes(newParentId);
}

/**
 * Returns full breadcrumb path array for a scope group from root down to itself.
 * E.g. [{ id: 1, name: "Central Railway" }, { id: 2, name: "Mumbai Division" }]
 */
export async function getScopeGroupBreadcrumbs(groupId: number): Promise<{ id: number; name: string; color: string | null }[]> {
  const path: { id: number; name: string; color: string | null }[] = [];
  let currentId: number | null = groupId;

  while (currentId !== null) {
    const g: any = await prisma.scopeGroup.findUnique({
      where: { id: currentId },
      select: { id: true, name: true, color: true, parentId: true }
    });
    if (!g) break;
    path.unshift({ id: g.id, name: g.name, color: g.color });
    currentId = g.parentId;
  }

  return path;
}
