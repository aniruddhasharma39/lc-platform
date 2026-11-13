import { prisma } from '../lib/prisma';
import { deleteFromCloudinary } from '../lib/cloudinaryUploader';

// Default retention window: 24 hours (allows supervisors to audit shifts across yesterday/overnight)
const RETENTION_HOURS = parseInt(process.env.ATTENDANCE_PHOTO_RETENTION_HOURS || '24', 10);
// Check every 1 hour (3600000 ms)
const CHECK_INTERVAL_MS = parseInt(process.env.ATTENDANCE_CLEANUP_INTERVAL_MS || '3600000', 10);

let isSweepRunning = false;
let sweepIntervalTimer: NodeJS.Timeout | null = null;

export interface RetentionSweepResult {
  scanned: number;
  purged: number;
  failed: number;
  cutoffDate: Date;
  durationMs: number;
}

/**
 * Runs a single sweep across the ShiftAttendance table.
 * Finds attendance selfies older than the retention window (24 hours),
 * deletes the heavy image asset from Cloudinary CDN, and updates the database record
 * with a clean audit indicator while preserving 100% of the railway safety log.
 */
export async function runAttendanceRetentionSweep(customRetentionHours?: number): Promise<RetentionSweepResult> {
  if (isSweepRunning) {
    console.log('[Attendance Retention Worker] Sweep already in progress. Skipping concurrent run.');
    return { scanned: 0, purged: 0, failed: 0, cutoffDate: new Date(), durationMs: 0 };
  }

  isSweepRunning = true;
  const startTime = Date.now();
  const hours = customRetentionHours !== undefined ? customRetentionHours : RETENTION_HOURS;
  const cutoffDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(`[Attendance Retention Worker] 🧹 Starting photo sweep (Purging selfies older than ${hours}h, cutoff: ${cutoffDate.toISOString()})...`);

  let scanned = 0;
  let purged = 0;
  let failed = 0;

  try {
    // Find all attendance records with active photo URLs older than cutoff
    const records = await prisma.shiftAttendance.findMany({
      where: {
        timestamp: { lt: cutoffDate },
        selfieUrl: { not: null },
        NOT: [
          { selfieUrl: { startsWith: '[PURGED' } },
        ],
      },
      select: {
        id: true,
        userId: true,
        date: true,
        shiftName: true,
        type: true,
        selfieUrl: true,
        timestamp: true,
      },
      take: 200, // Batch limit per cycle
    });

    scanned = records.length;
    console.log(`[Attendance Retention Worker] Found ${scanned} expired attendance photo(s) to purge.`);

    for (const record of records) {
      if (!record.selfieUrl) continue;

      try {
        const deleted = await deleteFromCloudinary(record.selfieUrl);
        if (deleted) {
          await prisma.shiftAttendance.update({
            where: { id: record.id },
            data: {
              selfieUrl: '[PURGED_24H_CYCLE_EXPIRED]',
            },
          });
          purged++;
        } else {
          // If already gone or couldn't reach, mark as purged to avoid endless retry
          await prisma.shiftAttendance.update({
            where: { id: record.id },
            data: {
              selfieUrl: '[PURGED_NOT_FOUND]',
            },
          });
          purged++;
        }
      } catch (err: any) {
        console.error(`[Attendance Retention Worker] Error purging record #${record.id}:`, err.message || err);
        failed++;
      }
    }
  } catch (dbErr: any) {
    console.error('[Attendance Retention Worker] Database query failed:', dbErr.message || dbErr);
  } finally {
    isSweepRunning = false;
  }

  const durationMs = Date.now() - startTime;
  console.log(`[Attendance Retention Worker] ✅ Sweep completed in ${durationMs}ms: Scanned: ${scanned}, Purged: ${purged}, Failed: ${failed}`);

  return {
    scanned,
    purged,
    failed,
    cutoffDate,
    durationMs,
  };
}

/**
 * Initializes the background rolling retention timer.
 * Runs an initial check 30 seconds after server launch, then recurs every hour.
 */
export function startAttendanceRetentionWorker(): void {
  if (sweepIntervalTimer) {
    console.log('[Attendance Retention Worker] Timer already initialized.');
    return;
  }

  console.log(`[Attendance Retention Worker] 🚀 Scheduled rolling retention worker (Window: ${RETENTION_HOURS}h, Interval: ${CHECK_INTERVAL_MS / 60000} mins)`);

  // Initial sweep delayed by 30 seconds to allow DB connection pooling to stabilize
  setTimeout(() => {
    runAttendanceRetentionSweep().catch((err) => {
      console.error('[Attendance Retention Worker] Initial sweep error:', err);
    });
  }, 30000);

  // Recurring sweep
  sweepIntervalTimer = setInterval(() => {
    runAttendanceRetentionSweep().catch((err) => {
      console.error('[Attendance Retention Worker] Periodic sweep error:', err);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopAttendanceRetentionWorker(): void {
  if (sweepIntervalTimer) {
    clearInterval(sweepIntervalTimer);
    sweepIntervalTimer = null;
    console.log('[Attendance Retention Worker] Stopped retention worker timer.');
  }
}
