-- Migration: 20261102000000_reports_caching_changelog
-- Description: Creates LCGateEventTombstone and LCGateEventChangeLog tables with composite indexes for transactionally ordered reports caching and synchronization.

-- Forward Migration (Deployment SQL):

-- 1. Create LCGateEventTombstone
CREATE TABLE IF NOT EXISTS "LCGateEventTombstone" (
    "id" BIGSERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "gateId" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LCGateEventTombstone_pkey" PRIMARY KEY ("id")
);

-- 2. Create LCGateEventChangeLog
CREATE TABLE IF NOT EXISTS "LCGateEventChangeLog" (
    "id" BIGSERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "gateId" INTEGER NOT NULL,
    "opType" TEXT NOT NULL,
    "gateRevision" BIGINT NOT NULL,
    "status" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "openedBy" TEXT,
    "closedBy" TEXT,
    "trainNumber" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LCGateEventChangeLog_pkey" PRIMARY KEY ("id")
);

-- 3. Composite & Monotonic Ordering Indexes
CREATE INDEX IF NOT EXISTS "LCGateEventTombstone_gateId_id_idx" ON "LCGateEventTombstone"("gateId", "id");
CREATE INDEX IF NOT EXISTS "LCGateEventTombstone_deletedAt_idx" ON "LCGateEventTombstone"("deletedAt");
CREATE INDEX IF NOT EXISTS "LCGateEventChangeLog_gateId_gateRevision_idx" ON "LCGateEventChangeLog"("gateId", "gateRevision");
CREATE INDEX IF NOT EXISTS "LCGateEventChangeLog_createdAt_idx" ON "LCGateEventChangeLog"("createdAt");

-- -----------------------------------------------------------------------------
-- Rollback / Downgrade SQL (Preserved for safe operator rollback):
-- -----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS "LCGateEventChangeLog";
-- DROP TABLE IF EXISTS "LCGateEventTombstone";

