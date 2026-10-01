// Day-of-week convention matches JS Date#getDay(): 0 = Sunday ... 6 = Saturday.

export interface WeeklyRange {
  dayOfWeek: number;
  startTime: string; // "HH:MM"
  endTime: string;
}

export interface DateOverride {
  date: string; // "YYYY-MM-DD"
  isUnavailable: boolean;
}

export interface DaySlots {
  date: string;
  slots: string[]; // "HH:MM" start times, sorted
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const toHHMM = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (totalMinutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
};

const toDateString = (d: Date): string => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// The Monday-to-Sunday week containing `now`, with days already past
// removed — per our Day 6 decision, a patient sees a shrinking window
// (Friday shows Fri/Sat/Sun only), never next week's dates early.
export const getVisibleWeekDates = (now: Date = new Date()): Date[] => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = today.getDay(); // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Sun->6, Mon->0, ... Sat->5
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysSinceMonday);

  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d >= today) dates.push(d);
  }
  return dates;
};

// Splits [startTime, endTime) into fixed slotDuration chunks. A range that
// isn't an exact multiple of the duration drops its last partial chunk —
// e.g. 9:00-9:50 at 20-minute slots yields 9:00 and 9:20 only.
const splitIntoSlots = (
  startTime: string,
  endTime: string,
  slotDurationMinutes: number,
): string[] => {
  const slots: string[] = [];
  let cursor = toMinutes(startTime);
  const end = toMinutes(endTime);
  while (cursor + slotDurationMinutes <= end) {
    slots.push(toHHMM(cursor));
    cursor += slotDurationMinutes;
  }
  return slots;
};

// Computes this week's bookable start times for one doctor, live from their
// weekly template and date overrides. Nothing is pre-generated or stored —
// this function is the entire "schedule".
export const computeWeeklyAvailability = (
  weeklyRanges: WeeklyRange[],
  overrides: DateOverride[],
  slotDurationMinutes: number,
  now: Date = new Date(),
): DaySlots[] => {
  const overrideMap = new Map(overrides.map((o) => [o.date, o.isUnavailable]));
  const visibleDates = getVisibleWeekDates(now);
  const todayStr = toDateString(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  );

  return visibleDates.map((date) => {
    const dateStr = toDateString(date);

    if (overrideMap.get(dateStr) === true) {
      return { date: dateStr, slots: [] };
    }

    const dayOfWeek = date.getDay();
    const rangesForDay = weeklyRanges.filter((r) => r.dayOfWeek === dayOfWeek);
    let slots = rangesForDay.flatMap((r) =>
      splitIntoSlots(r.startTime, r.endTime, slotDurationMinutes),
    );

    if (dateStr === todayStr) {
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      slots = slots.filter((s) => toMinutes(s) > nowMinutes);
    }

    slots.sort();
    return { date: dateStr, slots };
  });
};
