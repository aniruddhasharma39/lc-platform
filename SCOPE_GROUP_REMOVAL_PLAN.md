# Scope Group Removal Plan

## Goal
Completely remove the "Scope Group" feature from the application. Gate access will be determined solely by **role-based designation** (already implemented in `backend/src/lib/railwayHierarchy.ts` via `buildUserGateWhereClause` / `verifyGateAccess`), plus direct `UserGate` assignments for gate-level roles (e.g. Gateman).

## Current State
- Scope Groups provide hierarchical grouping of gates/users/devices and drive access filtering across backend, web, and mobile.
- A parallel, richer role-based access system already exists (`railwayHierarchy.ts`): Developer sees all gates; divisional officers see gates in their division/zone; station-level roles see station gates; gate-level roles see explicitly assigned gates.
- Scope groups are now redundant and cause duplicated/competing access logic.

## Issues Found
1. **Competing access models**: `resolveUserAccess` (reports) and lcgate filters use scope groups; `buildUserGateWhereClause` uses roles. Results can differ.
2. **No gate assignment UI for new model**: `UserGate` table exists but there is no UI to assign gates to users/roles beyond scope groups.
3. **Alerts (SMS/email) resolve recipients via scope groups** (`gateAlertSms.ts`, `emailService.ts`); removing them breaks notifications unless an alternative recipient resolver is added.
4. **Reports grouping by scope group** (`scopeGroupName`, `scopeGroupColor`) is used in records/export; removing scope groups requires flattening or using zone/division.
5. **Cache/revision system** keys off scope revisions (`DIRECTORY_SCOPE_REVISION_*`); needs simplification to global revision.
6. **Mobile/web** have dedicated Scope Groups screens and developer scope selectors that must be removed.

## Plan (Phased)

### Phase 1 — Backend access control (remove scope-group filtering)
- `backend/src/routes/lcgate.ts`: replace scope-group filtering in GET /, GET /:id, and update paths with `buildUserGateWhereClause` for non-developers (developer sees all).
- `backend/src/routes/reports.ts`: rewrite `resolveUserAccess` to return all gates accessible via `buildUserGateWhereClause`; remove `scopeGroupIds` query param handling; `targetScopeGroupIds` becomes empty/unused.
- `backend/src/routes/deviceRegistry.ts`: replace scope-group-based access/invalidation with role-based.
- `backend/src/routes/users.ts`: remove scope-group membership cleanup (no longer needed).
- `backend/src/routes/scopeGroups.ts`: delete file; remove registration in `index.ts`.
- `backend/src/lib/revisionManager.ts`: simplify to global revision only.
- `backend/src/lib/gateAlertSms.ts` & `emailService.ts`: resolve recipients by gate access (users whose role passes `verifyGateAccess` for the gate) instead of scope groups.
- `backend/src/lib/cycleReportService.ts` & `reportExporter.ts`: remove `scopeGroupName`/`scopeGroupColor` (use zone/division or "Unassigned").
- Keep DB tables (no migration) but stop reading/writing them.

### Phase 2 — Web frontend
- Remove `ScopeGroups` screen and route; remove module entry from navigation.
- `ClusterDashboard.tsx`: remove developer scope selector; show all gates accessible to user (already filtered by backend).
- `ReportsScreen.tsx`: flatten cluster tree to a flat gate list; remove scope-group filters.
- `types.ts`: remove `ScopeGroupItem`.

### Phase 3 — Mobile frontend
- Remove `scope_groups` screens and dashboard navigation entry.
- `cluster_main_screen.dart`: remove `_allScopeGroupsList` and developer scope selector.
- `lc_gates_cache_service.dart`: remove scope-group caching/invalidation.
- `reports_screen.dart`: flatten cluster tree to flat gate list.

### Phase 4 — Cleanup
- Remove `scope-groups` module from `ensureDesignationRoles` defaultModuleSlugs.
- Remove tests referencing scope groups or update them.
- Remove `scopeHierarchy.ts` (or leave unused).

## Risks
- Users previously assigned only via scope groups (not UserGate/division) may lose gate access; migration of assignments needed.
- Alerts recipient resolution change may alter who gets notified.
- Reports UX changes (no scope grouping).

## Recommended First Step
Implement Phase 1 backend changes while keeping responses backward-compatible (return empty `scopeGroupIds`), then update frontends. Confirm before destructive DB changes.
