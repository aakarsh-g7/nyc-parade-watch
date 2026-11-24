const zone = "America/New_York";
const wallClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: zone,
  hour: "numeric",
  minute: "2-digit",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  timeZone: zone,
  month: "short",
  day: "numeric",
});

export const paradeMorning = Date.parse("2026-11-26T09:42:00-05:00");

export function nycDateInput(time: number) {
  const parts = Object.fromEntries(wallClock.formatToParts(time).map(({ type, value }) => [type, value]));
  return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute;
}

export function parseNycDateInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const wallTime = Date.parse(value + ":00Z");
  if (!Number.isFinite(wallTime)) return null;
  for (const offset of [4, 5]) {
    const candidate = wallTime + offset * 3_600_000;
    if (nycDateInput(candidate) === value) return candidate;
  }
  return null;
}

export const formatClock = (time: number) => clock.format(time);
export const formatDay = (time: number) => shortDate.format(time);

export function minutes(seconds: number) {
  return Math.max(0, Math.ceil(seconds / 60));
}
