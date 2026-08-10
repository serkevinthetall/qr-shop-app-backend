// Myanmar is UTC+6:30 (390 minutes), same default as notification "today" logic.
const DEFAULT_TZ_OFFSET_MINUTES = Number(process.env.NOTIFY_TZ_OFFSET_MINUTES || 390);

const MONTH_NAME_TO_NUMBER = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/**
 * Calendar year/month in the configured local timezone.
 * @returns {{ year: number, month: number }}
 */
export function getLocalYearMonth(
  now = new Date(),
  offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES
) {
  const local = new Date(now.getTime() + offsetMinutes * 60000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
  };
}

/**
 * Parse Odoo `x_studio_ticket_month` (date, char, or many2one display).
 * @returns {{ year: number, month: number } | null}
 */
export function parseTicketMonth(value) {
  if (value == null || value === false) {
    return null;
  }

  // many2one: [id, "August 2026"]
  if (Array.isArray(value)) {
    return parseTicketMonth(value[1] ?? value[0]);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    // Bare numeric id cannot be mapped to a month.
    return null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS or YYYY-MM
  let match = raw.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:\s|$)/);
  if (match) {
    return toYearMonth(match[1], match[2]);
  }

  // Month YYYY / Mon YYYY (e.g. "August 2026", "Aug 2026")
  match = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const month = MONTH_NAME_TO_NUMBER[match[1].toLowerCase()];
    if (month) {
      return { year: Number(match[2]), month };
    }
  }

  // YYYY Month
  match = raw.match(/^(\d{4})\s+([A-Za-z]+)$/);
  if (match) {
    const month = MONTH_NAME_TO_NUMBER[match[2].toLowerCase()];
    if (month) {
      return { year: Number(match[1]), month };
    }
  }

  // M/YYYY or MM-YYYY
  match = raw.match(/^(\d{1,2})[/-](\d{4})$/);
  if (match) {
    return toYearMonth(match[2], match[1]);
  }

  // YYYY/M
  match = raw.match(/^(\d{4})[/-](\d{1,2})$/);
  if (match) {
    return toYearMonth(match[1], match[2]);
  }

  return null;
}

function toYearMonth(yearRaw, monthRaw) {
  const year = Number(yearRaw);
  const month = Number(monthRaw);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month };
}

export function isCurrentTicketMonth(
  value,
  now = new Date(),
  offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES
) {
  const parsed = parseTicketMonth(value);
  if (!parsed) {
    return false;
  }

  const current = getLocalYearMonth(now, offsetMinutes);
  return parsed.year === current.year && parsed.month === current.month;
}

/**
 * Keep only tickets for the current local calendar month.
 * Prefer "Currently Available", then higher id.
 */
export function filterCouponsForCurrentMonth(coupons, now = new Date()) {
  const currentMonth = (Array.isArray(coupons) ? coupons : []).filter((coupon) =>
    isCurrentTicketMonth(coupon?.x_studio_ticket_month, now)
  );

  currentMonth.sort((a, b) => {
    const aAvailable =
      a.x_studio_status === "Currently Available" && !a.x_studio_used_sale_order ? 1 : 0;
    const bAvailable =
      b.x_studio_status === "Currently Available" && !b.x_studio_used_sale_order ? 1 : 0;

    if (aAvailable !== bAvailable) {
      return bAvailable - aAvailable;
    }

    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });

  return currentMonth;
}
