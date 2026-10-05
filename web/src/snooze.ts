/** "Snooze" hides a ticket from the board until a time, for work that needs a follow-up later. */

export type SnoozeOption = "1h" | "4h" | "tomorrow" | "3d" | "monday" | "1w" | "2w" | "date";

export const SNOOZE_OPTIONS: { id: SnoozeOption; label: string }[] = [
  { id: "1h", label: "1 hour" },
  { id: "4h", label: "4 hours" },
  { id: "tomorrow", label: "Tomorrow 9:00" },
  { id: "3d", label: "3 days" },
  { id: "monday", label: "Next Monday 9:00" },
  { id: "1w", label: "1 week" },
  { id: "2w", label: "2 weeks" },
  { id: "date", label: "Pick a date…" },
];

export const DEFAULT_SNOOZE: SnoozeOption = "tomorrow";

/** A follow-up is a start-of-day task, so each option longer than a day lands at 9:00 local time. */
function morning(now: Date, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** `date` is a `YYYY-MM-DD` from the date input. Null when the option needs a date that is missing or bad. */
export function snoozeUntil(option: SnoozeOption, now: Date, date = ""): Date | null {
  switch (option) {
    case "1h":
      return new Date(now.getTime() + 3_600_000);
    case "4h":
      return new Date(now.getTime() + 4 * 3_600_000);
    case "tomorrow":
      return morning(now, 1);
    case "3d":
      return morning(now, 3);
    case "monday":
      return morning(now, ((8 - now.getDay()) % 7) || 7);
    case "1w":
      return morning(now, 7);
    case "2w":
      return morning(now, 14);
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9);
      return d.getTime() > now.getTime() ? d : null;
    }
  }
}

export function isSnoozed(until: string | undefined, now: number): boolean {
  return !!until && Date.parse(until) > now;
}

/** "14:30" today, "Tue 9:00" this week, else "Oct 15 9:00". */
export function untilLabel(until: string, now: number): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (d.getTime() - now) / 86_400_000;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  if (days < 6) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
