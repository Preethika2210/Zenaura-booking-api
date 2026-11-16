// Open slots are worked out on the fly: each dentist's weekly schedule, cut
// into 30-minute slots for the next 6 weeks, minus slots already booked,
// minus slots that are in the past or less than 1 hour away.
const t = require('./time');

const SLOT_MINUTES = 30;
const WINDOW_DAYS = 42;          // 6 weeks
const MIN_NOTICE_MINUTES = 60;   // no booking less than 1 hour ahead
const BUSY_SHARE = 0.35;         // share of slots shown as already taken, so the diary looks real

const SLOT_ID_RE = /^(\d{8})-(\d{4})-([A-Za-z0-9]+)$/;

function slotId(date, time, dentistId) {
  return `${t.compactDate(date)}-${t.compactTime(time)}-${dentistId}`;
}

function parseSlotId(id) {
  const m = typeof id === 'string' ? id.trim().match(SLOT_ID_RE) : null;
  if (!m) return null;
  const date = t.expandDate(m[1]);
  const time = t.expandTime(m[2]);
  if (!t.isValidDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return { date, time, dentistId: m[3] };
}

// Deterministic "busy" marker: the same slot is always busy or always free,
// so lists stay stable between calls. Set BUSY_SHARE to 0 to show every slot.
function looksBusy(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 < BUSY_SHARE;
}

function inScheduleAt(dentist, date, time) {
  const blocks = dentist.schedule[String(t.isoWeekday(date))] || [];
  const m = t.toMinutes(time);
  return blocks.some(([s, e]) => m >= t.toMinutes(s) && m + SLOT_MINUTES <= t.toMinutes(e)
    && (m - t.toMinutes(s)) % SLOT_MINUTES === 0);
}

function isFuture(date, time, now) {
  if (date > now.date) return true;
  if (date < now.date) return false;
  return t.toMinutes(time) >= now.minutes + MIN_NOTICE_MINUTES;
}

function inWindow(date, now) {
  return date >= now.date && date <= t.addDays(now.date, WINDOW_DAYS - 1);
}

function slotObject(date, time, dentist) {
  return {
    slotId: slotId(date, time, dentist.id),
    date,
    time,
    dateLabel: t.dateLabel(date),
    timeLabel: t.timeLabel(time),
    dentistId: dentist.id,
    dentist: dentist.name,
    dentistNote: dentist.note || null,
  };
}

// All open slots for the given dentists, sorted by date, time, dentist.
// booked: Set of "dentistId|date|time" strings for active bookings.
function openSlots({ dentists, booked, from, to, now }) {
  const start = from && from > now.date ? from : now.date;
  const last = t.addDays(now.date, WINDOW_DAYS - 1);
  const end = to && to < last ? to : last;
  const out = [];
  for (let date = start; date <= end; date = t.addDays(date, 1)) {
    const wd = String(t.isoWeekday(date));
    for (const d of dentists) {
      for (const [s, e] of d.schedule[wd] || []) {
        for (let m = t.toMinutes(s); m + SLOT_MINUTES <= t.toMinutes(e); m += SLOT_MINUTES) {
          const time = t.fromMinutes(m);
          if (!isFuture(date, time, now)) continue;
          const id = slotId(date, time, d.id);
          if (booked.has(`${d.id}|${date}|${time}`) || looksBusy(id)) continue;
          out.push(slotObject(date, time, d));
        }
      }
    }
  }
  out.sort((a, b) => (a.date + a.time + a.dentistId).localeCompare(b.date + b.time + b.dentistId));
  return out;
}

// One slot per time (first free dentist), for lists without a dentist preference.
function onePerTime(slots) {
  const seen = new Set();
  return slots.filter((s) => {
    const k = `${s.date}|${s.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Can this exact slot be booked right now?
function isBookable({ dentist, date, time, booked, now }) {
  if (!inWindow(date, now) || !isFuture(date, time, now)) return false;
  if (!inScheduleAt(dentist, date, time)) return false;
  const id = slotId(date, time, dentist.id);
  if (looksBusy(id)) return false;
  return !booked.has(`${dentist.id}|${date}|${time}`);
}

module.exports = { openSlots, onePerTime, isBookable, parseSlotId, slotObject, slotId, isFuture };
