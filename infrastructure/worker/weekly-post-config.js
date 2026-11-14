// Validation for the admin config row `weekly_post` (weekly-post.js). Its own module so config.js can import it without a cycle.
// lead_hours starts at 24: the 6-hourly cron plus the default quiet hours (1 to 9 AM ET) can hold a post for up to 18 hours, and a
// two-year simulation of every weekday and hour found leads under 18 hours that never post at all (review of the first version).
export const DEFAULT_LEAD_HOURS = 24;
export const MIN_LEAD_HOURS = 24;
export const MAX_LEAD_HOURS = 72;

export function validateWeeklyConfig(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "weekly_post must be a JSON object";
  for (const k of Object.keys(v)) if (!["weekday", "hour", "minute", "lead_hours", "channel"].includes(k)) return `weekly_post: unknown field ${k}`;
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!int(v.weekday, 0, 6)) return "weekday must be 0 (Sunday) to 6, in UTC";
  if (!int(v.hour, 0, 23)) return "hour must be 0 to 23, in UTC";
  if (v.minute !== undefined && !int(v.minute, 0, 59)) return "minute must be 0 to 59";
  if (v.lead_hours !== undefined && !int(v.lead_hours, MIN_LEAD_HOURS, MAX_LEAD_HOURS)) return `lead_hours must be ${MIN_LEAD_HOURS} to ${MAX_LEAD_HOURS}`;
  if (v.channel !== undefined && !(typeof v.channel === "string" && /^[0-9]{5,25}$/.test(v.channel))) return "channel must be a Discord channel id";
  return null;
}
