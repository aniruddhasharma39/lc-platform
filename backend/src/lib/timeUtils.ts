const IST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 3600000;

/**
 * Convert Date to YYYY-MM-DD string in Indian Standard Time (IST).
 */
export function getISTDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TIMEZONE }).format(date);
}

/**
 * Compute default YYYY-MM-DD start and end dates in IST (defaults to last 7 days inclusive).
 */
export function getISTDateRangeDefaults(
  daysBack = 7,
  referenceDate: Date = new Date()
): { defaultStart: string; defaultEnd: string } {
  const defaultEnd = getISTDateString(referenceDate);
  const [y, m, d] = defaultEnd.split('-').map(Number);
  const startNoonUtc = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) - daysBack, 12, 0, 0));
  const defaultStart = getISTDateString(startNoonUtc);
  return { defaultStart, defaultEnd };
}

/**
 * Compute UTC boundary Date for a single YYYY-MM-DD calendar date in IST.
 */
export function getISTUtcBoundaryForSingleDate(dateStr: string, boundary: 'start' | 'end'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid IST date string: "${dateStr}"`);
  }
  if (boundary === 'start') {
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  }
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS);
}

/**
 * Compute UTC date boundaries for an inclusive IST date range [startDateStr, endDateStr].
 */
export function getISTUtcDateBounds(startDateStr: string, endDateStr: string): { startUtc: Date; endUtc: Date } {
  return {
    startUtc: getISTUtcBoundaryForSingleDate(startDateStr, 'start'),
    endUtc: getISTUtcBoundaryForSingleDate(endDateStr, 'end'),
  };
}

/**
 * Format YYYY-MM-DD nicely in IST: e.g. "01 October 2026".
 */
export function formatISTDateDisplay(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: IST_TIMEZONE,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(dateObj);
  } catch {
    return dateStr;
  }
}

/**
 * Format a Date as 24-hour HH:mm:ss string in IST.
 */
export function formatISTTimeString(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Format a gate closure timestamp cleanly in IST ("Today at 01:15 AM" or "Nov 11 at 01:15 AM").
 */
export function formatLastClosedIST(closedDate: Date, now: Date = new Date()): string {
  const isTodayIst = getISTDateString(closedDate) === getISTDateString(now);
  const timeStr = closedDate.toLocaleTimeString('en-IN', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
  if (isTodayIst) {
    return `Today at ${timeStr}`;
  }
  const dateLabel = closedDate.toLocaleDateString('en-US', {
    timeZone: IST_TIMEZONE,
    month: 'short',
    day: 'numeric',
  });
  return `${dateLabel} at ${timeStr}`;
}

/**
 * Return the 0..23 clock hour in IST for shift classification.
 */
export function getISTHour(date: Date): number {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
}

