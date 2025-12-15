// Minimal Japan public holidays list for holiday-aware scheduling.
// Covers 2024-2026. Extend as needed.

export function isJapanHolidayJst(date: Date): boolean {
  // Convert to JST date (YYYY-MM-DD)
  const jst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = (jst.getMonth() + 1).toString().padStart(2, '0');
  const d = jst.getDate().toString().padStart(2, '0');
  const key = `${y}-${m}-${d}`;

  // Weekends already filtered by schedules, but keep here if needed
  const dow = jst.getDay(); // 0 Sun, 6 Sat
  if (dow === 0 || dow === 6) return true;

  const holidays = new Set<string>([
    // 2024
    '2024-01-01', // New Year's Day
    '2024-01-08', // Coming of Age Day (2nd Mon Jan)
    '2024-02-11', // National Foundation Day (Sun)
    '2024-02-12', // Substitute holiday
    '2024-02-23', // Emperor's Birthday
    '2024-03-20', // Vernal Equinox Day
    '2024-04-29', // Showa Day
    '2024-05-03', // Constitution Memorial Day
    '2024-05-04', // Greenery Day
    '2024-05-05', // Children's Day (Sun)
    '2024-05-06', // Substitute holiday
    '2024-07-15', // Marine Day (3rd Mon Jul)
    '2024-08-11', // Mountain Day (Sun)
    '2024-08-12', // Substitute holiday
    '2024-09-16', // Respect for the Aged Day (3rd Mon Sep)
    '2024-09-22', // Autumnal Equinox Day (Sun)
    '2024-09-23', // Substitute holiday
    '2024-10-14', // Health and Sports Day (2nd Mon Oct)
    '2024-11-03', // Culture Day (Sun)
    '2024-11-04', // Substitute holiday
    '2024-11-23', // Labor Thanksgiving Day (Sat)

    // 2025
    '2025-01-01', // New Year's Day
    '2025-01-13', // Coming of Age Day
    '2025-02-11', // National Foundation Day
    '2025-02-23', // Emperor's Birthday (Sun)
    '2025-02-24', // Substitute holiday
    '2025-03-20', // Vernal Equinox Day
    '2025-04-29', // Showa Day
    '2025-05-03', // Constitution Memorial Day (Sat)
    '2025-05-04', // Greenery Day (Sun)
    '2025-05-05', // Children's Day (Mon)
    '2025-05-06', // Substitute holiday
    '2025-07-21', // Marine Day
    '2025-08-11', // Mountain Day
    '2025-09-15', // Respect for the Aged Day
    '2025-09-23', // Autumnal Equinox Day
    '2025-10-13', // Sports Day
    '2025-11-03', // Culture Day
    '2025-11-23', // Labor Thanksgiving Day (Sun)
    '2025-11-24', // Substitute holiday

    // 2026 (partial)
    '2026-01-01',
    '2026-01-12',
    '2026-02-11',
    '2026-02-23',
    '2026-03-20',
    '2026-04-29',
    '2026-05-03',
    '2026-05-04',
    '2026-05-05',
    '2026-07-20',
    '2026-08-11',
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-10-12',
    '2026-11-03',
    '2026-11-23',
  ]);

  return holidays.has(key);
}

