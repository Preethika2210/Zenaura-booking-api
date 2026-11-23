// ZenAura Dental booking API (demo).
// Patient API for the Zendesk AI agent (same contract as the original POC),
// plus membership tiers, member priority slots, a waitlist, a demo website
// and a full staff console. Backed by Postgres (Supabase).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const t = require('./time');
const S = require('./slots');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL;
const WIDGET_KEY = process.env.ZENDESK_WIDGET_KEY || '';
const OFFER_HOLD_MINUTES = 120; // a freed slot is held for the next waitlisted patient for 2 hours

if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!API_KEY) { console.error('API_KEY is not set'); process.exit(1); }

const local = /localhost|127\.0\.0\.1|\/var\/run|\/tmp\//.test(DATABASE_URL) || DATABASE_URL.includes('host=/');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 5,
});

// Keep the date column as text YYYY-MM-DD (avoids time zone shifts in pg).
require('pg').types.setTypeParser(1082, (v) => v);

// ---------- reference data ------------------------------------------
const REGIONS = ['Central', 'East', 'North', 'North-East', 'West'];
const DAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'PH'];
const STATUS_LABEL = {
  requested: 'Pending clinic confirmation',
  confirmed: 'Confirmed',
  rejected: 'Declined by clinic',
  cancelled: 'Cancelled',
};
const WAIT_LABEL = { waiting: 'Waiting', offered: 'Slot offered', booked: 'Booked', removed: 'Removed' };
const ACTIVE = ['requested', 'confirmed'];

const TIERS = {
  standard: {
    label: 'Standard', rank: 0, ticketPriority: 'normal',
    perks: ['Book, reschedule and cancel online at any time'],
  },
  silver: {
    label: 'Silver', rank: 1, ticketPriority: 'normal',
    perks: ['Placed ahead of Standard patients on the waitlist', 'Book, reschedule and cancel online at any time'],
  },
  gold: {
    label: 'Gold', rank: 2, ticketPriority: 'high',
    perks: ["Member priority slots: the first appointments of each dentist's day",
      'Placed ahead of Silver and Standard patients on the waitlist',
      'High priority when you ask to talk to our team'],
  },
  platinum: {
    label: 'Platinum', rank: 3, ticketPriority: 'urgent',
    perks: ["Member priority slots: the first appointments of each dentist's day",
      'Top of the waitlist: freed slots are offered to you first',
      'Urgent priority when you ask to talk to our team'],
  },
};
const TIER_IDS = Object.keys(TIERS);
const tierInfo = (id) => TIERS[id] || TIERS.standard;

// Services live in the database so staff can add them; cached in memory.
let SERVICES = [];        // active, for patients
let SERVICE_NAMES = {};   // all, including inactive, for old bookings
let servicesLoaded = false;
async function loadServices() {
  const { rows } = await pool.query('select id, name, active from services order by sort, name');
  SERVICES = rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  SERVICE_NAMES = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  servicesLoaded = true;
}
const serviceName = (id) => SERVICE_NAMES[id] || id;

// ---------- helpers --------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function normMobile(input) {
  if (input === undefined || input === null) return null;
  const digits = String(input).replace(/[^\d]/g, '');
  let local8 = digits;
  if (digits.length === 10 && digits.startsWith('65')) local8 = digits.slice(2);
  if (!/^[3689]\d{7}$/.test(local8)) return null;
  return `+65${local8}`;
}
function needMobile(v) {
  const m = normMobile(v);
  if (!m) fail(400, 'invalid_mobile', 'Please give a valid Singapore mobile number, for example 9123 4567.');
  return m;
}
function needName(v) {
  const name = str(v, 100);
  if (name.length < 2 || name.length > 66) fail(400, 'invalid_name', 'Please give your full name (2 to 66 characters).');
  return name;
}
function optEmail(v) {
  const email = str(v, 120) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'That email address does not look right. Please check it.');
  return email;
}

function checkService(s, required) {
  const msg = `Please choose a service: ${SERVICES.map((x) => x.id).join(', ')}.`;
  if (s === undefined || s === null || s === '') {
    if (required) fail(400, 'invalid_service', msg);
    return null;
  }
  const v = String(s).trim().toLowerCase();
  if (!SERVICES.some((x) => x.id === v)) fail(400, 'invalid_service', msg);
  return v;
}

function checkDate(s, field = 'date') {
  if (!t.isValidDate(String(s || '').trim())) fail(400, 'invalid_date', `Please give the ${field === 'from' ? 'start date' : 'date'} as YYYY-MM-DD.`);
  return String(s).trim();
}

// "2:30 PM" for a timestamp, in Singapore time
function sgTimeLabel(ts) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts));
  return t.timeLabel(`${p.find((x) => x.type === 'hour').value}:${p.find((x) => x.type === 'minute').value}`);
}

function randomCode(prefix, n = 4) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = prefix;
  for (let i = 0; i < n; i += 1) s += letters[crypto.randomInt(letters.length)];
  return s;
}

async function logEvent(kind, ref, actor, detail) {
  try {
    await pool.query('insert into events (kind, ref, actor, detail) values ($1,$2,$3,$4)', [kind, ref || null, actor, detail]);
  } catch (e) { console.error('event log failed', e.message); }
}

// ---------- output shapes ----------------------------------------------
function clinicOut(c) {
  return {
    id: c.id,
    name: c.name,
    area: c.area,
    region: c.region,
    address: c.address,
    phone: c.phone,
    hours: c.hours,
    mapsUrl: c.maps_url,
    cardTitle: c.area,
    cardDescription: `${c.address} · ${c.phone}`,
    buttonText: 'Select',
  };
}

function bookingOut(b, clinic, dentist) {
  const sName = serviceName(b.service);
  const dl = t.dateLabel(b.slot_date);
  const tl = t.timeLabel(b.slot_time);
  const tier = tierInfo(b.tier);
  return {
    ref: b.ref,
    status: b.status,
    statusLabel: STATUS_LABEL[b.status],
    clinic: { id: clinic.id, name: clinic.name, address: clinic.address, phone: clinic.phone },
    service: { id: b.service, name: sName },
    dentist: dentist.name,
    dentistId: dentist.id,
    date: b.slot_date,
    time: b.slot_time,
    dateLabel: dl,
    timeLabel: tl,
    patient: { name: b.patient_name, mobile: b.patient_mobile, email: b.patient_email },
    tier: b.tier,
    tierLabel: tier.label,
    source: b.source,
    notes: b.notes,
    rescheduleCount: b.reschedule_count,
    cancelReason: b.cancel_reason,
    channel: b.channel,
    conversationId: b.conversation_id,
    createdAt: new Date(b.created_at).toISOString(),
    updatedAt: new Date(b.updated_at).toISOString(),
    cardTitle: sName,
    cardDescription: `${dl}, ${tl} · ${clinic.area} · ${dentist.name}`,
    summary: `${b.ref}: ${sName} at ${clinic.name} with ${dentist.name} on ${dl} at ${tl}. Status: ${STATUS_LABEL[b.status]}.`,
  };
}

async function lookups() {
  const [{ rows: c }, { rows: d }] = await Promise.all([
    pool.query('select * from clinics'),
    pool.query('select * from dentists'),
  ]);
  return { clinics: new Map(c.map((x) => [x.id, x])), dentists: new Map(d.map((x) => [x.id, x])) };
}

async function expandBooking(b, L) {
  const look = L || await lookups();
  return bookingOut(b, look.clinics.get(b.clinic_id), look.dentists.get(b.dentist_id));
}

// Waitlist positions: waiting entries per clinic + service, best tier first, then oldest first.
async function waitPositions() {
  const { rows } = await pool.query(
    `select ref, row_number() over (partition by clinic_id, service order by priority desc, created_at) as pos
       from waitlist where status = 'waiting'`,
  );
  return new Map(rows.map((r) => [r.ref, Number(r.pos)]));
}

function waitlistOut(w, pos, L) {
  const clinic = L.clinics.get(w.clinic_id);
  const sName = serviceName(w.service);
  const tier = tierInfo(w.tier);
  const dentist = w.dentist_id ? L.dentists.get(w.dentist_id) : null;
  let offer = null;
  if (w.status === 'offered' && w.offered_date) {
    const od = L.dentists.get(w.offered_dentist_id);
    offer = {
      slotId: S.slotId(w.offered_date, w.offered_time, w.offered_dentist_id),
      date: w.offered_date,
      time: w.offered_time,
      dateLabel: t.dateLabel(w.offered_date),
      timeLabel: t.timeLabel(w.offered_time),
      dentist: od ? od.name : w.offered_dentist_id,
      expiresAt: new Date(w.offer_expires).toISOString(),
      expiresLabel: sgTimeLabel(w.offer_expires),
    };
  }
  const position = w.status === 'waiting' ? (pos.get(w.ref) || null) : null;
  let summary;
  if (offer) {
    summary = `${w.ref}: Good news! ${offer.dateLabel} at ${offer.timeLabel} with ${offer.dentist} at ${clinic.area} is held for you until ${offer.expiresLabel}. Say yes to book it.`;
  } else if (w.status === 'waiting') {
    summary = `${w.ref}: You are number ${position} on the waitlist for ${sName} at ${clinic.name}${dentist ? ` with ${dentist.name}` : ''}. When a slot frees up, it is held for you for 2 hours.`;
  } else {
    summary = `${w.ref}: ${WAIT_LABEL[w.status]}${w.booking_ref ? ` (booking ${w.booking_ref})` : ''}.`;
  }
  return {
    ref: w.ref,
    status: w.status,
    statusLabel: WAIT_LABEL[w.status],
    clinic: { id: clinic.id, name: clinic.name, area: clinic.area },
    service: { id: w.service, name: sName },
    dentist: dentist ? dentist.name : 'Any dentist',
    dentistId: w.dentist_id,
    fromDate: w.from_date,
    patient: { name: w.patient_name, mobile: w.patient_mobile },
    tier: w.tier,
    tierLabel: tier.label,
    priority: w.priority,
    position,
    offer,
    bookingRef: w.booking_ref,
    notes: w.notes,
    createdAt: new Date(w.created_at).toISOString(),
    cardTitle: `${sName} · ${clinic.area}`,
    cardDescription: offer ? `Held for you: ${offer.dateLabel}, ${offer.timeLabel}` : `${WAIT_LABEL[w.status]}${position ? ` · number ${position}` : ''}`,
    summary,
  };
}

// ---------- data access ------------------------------------------------
async function getClinic(id, includeInactive = false) {
  const { rows } = await pool.query(`select * from clinics where id = $1${includeInactive ? '' : ' and active'}`, [id]);
  if (!rows[0]) fail(404, 'clinic_not_found', `No clinic with id "${id}". Use the clinics list for valid ids.`);
  return rows[0];
}

async function getDentists(clinicId, { service, dentistId } = {}) {
  const { rows } = await pool.query('select * from dentists where clinic_id = $1 and active order by id', [clinicId]);
  return rows.filter((d) => (!service || d.services.includes(service))
    && (!dentistId || d.id.toLowerCase() === String(dentistId).toLowerCase()));
}

async function getPatient(mobile) {
  if (!mobile) return null;
  const { rows } = await pool.query('select * from patients where mobile = $1', [mobile]);
  return rows[0] || null;
}

// Tier rank for an optional ?mobile= on the slot lists. Unknown or invalid = 0.
async function rankFor(mobileInput) {
  const p = await getPatient(normMobile(mobileInput));
  return p ? tierInfo(p.tier).rank : 0;
}

// Create the patient on first contact; never overwrite staff-managed details.
async function upsertPatient(mobile, name, email) {
  const { rows } = await pool.query(
    `insert into patients (mobile, name, email) values ($1, $2, $3)
     on conflict (mobile) do update set email = coalesce(patients.email, excluded.email)
     returning *`,
    [mobile, name, email],
  );
  return rows[0];
}

// Taken slots: active bookings plus slots held for a waitlisted patient.
async function bookedSet(dentistIds, ignoreWaitRef) {
  if (!dentistIds.length) return new Set();
  const today = t.nowSG().date;
  const [{ rows: b }, { rows: w }] = await Promise.all([
    pool.query(
      `select dentist_id, slot_date, slot_time from bookings
        where dentist_id = any($1) and status = any($2) and slot_date >= $3`,
      [dentistIds, ACTIVE, today],
    ),
    pool.query(
      `select offered_dentist_id as dentist_id, offered_date as slot_date, offered_time as slot_time from waitlist
        where status = 'offered' and offer_expires > now() and offered_dentist_id = any($1)
          and ($2::text is null or ref <> $2)`,
      [dentistIds, ignoreWaitRef || null],
    ),
  ]);
  return new Set([...b, ...w].map((r) => `${r.dentist_id}|${r.slot_date}|${r.slot_time}`));
}

async function loadBooking(ref, mobile) {
  const m = normMobile(mobile);
  const { rows } = await pool.query('select * from bookings where upper(ref) = upper($1)', [str(ref, 20)]);
  const b = rows[0];
  if (!b || !m || b.patient_mobile !== m) {
    fail(404, 'booking_not_found', 'We could not find a booking with that reference and mobile number. Please check both.');
  }
  return b;
}

function isChangeable(b) {
  return ACTIVE.includes(b.status) && S.isFuture(b.slot_date, b.slot_time, t.nowSG());
}

function notChangeable(b) {
  if (b.status === 'cancelled') fail(409, 'not_changeable', "This booking is cancelled and can't be changed.");
  if (b.status === 'rejected') fail(409, 'not_changeable', "This booking was declined by the clinic and can't be changed.");
  fail(409, 'not_changeable', "This booking time has passed and can't be changed.");
}

// Shared check for a slot being booked or moved to.
async function claimableSlot({ clinicId, slotIdValue, service, ignoreRef, ignoreWaitRef, memberRank = 0 }) {
  const p = S.parseSlotId(slotIdValue);
  if (!p) fail(400, 'invalid_slot', 'slotId is not valid; take it from the slots list');
  const { rows } = await pool.query('select * from dentists where lower(id) = lower($1) and active', [p.dentistId]);
  const dentist = rows[0];
  const taken = () => fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
  if (!dentist || dentist.clinic_id !== clinicId || !dentist.services.includes(service)) taken();
  const [{ rows: clash }, { rows: held }] = await Promise.all([
    pool.query(
      `select ref from bookings where dentist_id = $1 and slot_date = $2 and slot_time = $3
         and status = any($4) and ($5::text is null or ref <> $5)`,
      [dentist.id, p.date, p.time, ACTIVE, ignoreRef || null],
    ),
    pool.query(
      `select ref from waitlist where status = 'offered' and offer_expires > now()
         and offered_dentist_id = $1 and offered_date = $2 and offered_time = $3
         and ($4::text is null or ref <> $4)`,
      [dentist.id, p.date, p.time, ignoreWaitRef || null],
    ),
  ]);
  const booked = new Set(clash.length || held.length ? [`${dentist.id}|${p.date}|${p.time}`] : []);
  const verdict = S.bookable({ dentist, date: p.date, time: p.time, booked, now: t.nowSG(), memberRank });
  if (verdict === 'members_only') {
    fail(409, 'members_only', 'That time is held for Gold and Platinum members until 2 days before. Please choose another time.');
  }
  if (verdict !== 'ok') taken();
  return { dentist, date: p.date, time: p.time };
}

async function insertBooking({ clinic, service, slot, name, mobile, email, notes, channel, conversationId, source }) {
  const patient = await upsertPatient(mobile, name, email);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `insert into bookings (ref, clinic_id, dentist_id, service, slot_date, slot_time,
           patient_name, patient_mobile, patient_email, tier, source, notes, channel, conversation_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [randomCode('ZD-'), clinic.id, slot.dentist.id, service, slot.date, slot.time, name, mobile, email,
          patient.tier, source, notes || null, channel || null, conversationId || null],
      );
      return rows[0];
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'bookings_one_active_per_slot') {
        fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
      }
      if (e.code !== '23505') throw e; // ref collision: try a new ref
    }
  }
  return fail(500, 'server_error', 'Could not create the booking. Please try again.');
}

// Offers that ran out go back to waiting (they keep their place).
async function expireOffers() {
  const { rows } = await pool.query(
    `update waitlist set status = 'waiting', offered_dentist_id = null, offered_date = null,
       offered_time = null, offer_expires = null, updated_at = now()
     where status = 'offered' and offer_expires <= now() returning ref`,
  );
  for (const r of rows) await logEvent('waitlist_offer_expired', r.ref, 'system', 'Offer expired after 2 hours; back to waiting');
}

// A booked slot was freed: hold it for the highest-priority waiting patient.
async function offerFreedSlot(dentistId, date, time) {
  try {
    if (!S.isFuture(date, time, t.nowSG())) return null;
    const { rows: dr } = await pool.query('select * from dentists where id = $1 and active', [dentistId]);
    const dentist = dr[0];
    if (!dentist) return null;
    const { rows: busy } = await pool.query(
      `select 1 from bookings where dentist_id = $1 and slot_date = $2 and slot_time = $3 and status = any($4)
       union all select 1 from waitlist where status = 'offered' and offer_expires > now()
         and offered_dentist_id = $1 and offered_date = $2 and offered_time = $3`,
      [dentistId, date, time, ACTIVE],
    );
    if (busy.length) return null;
    const { rows } = await pool.query(
      `select * from waitlist where status = 'waiting' and clinic_id = $1 and service = any($2)
         and (dentist_id is null or dentist_id = $3) and (from_date is null or from_date <= $4)
       order by priority desc, created_at limit 1`,
      [dentist.clinic_id, dentist.services, dentist.id, date],
    );
    if (!rows[0]) return null;
    const { rows: up } = await pool.query(
      `update waitlist set status = 'offered', offered_dentist_id = $2, offered_date = $3, offered_time = $4,
         offer_expires = now() + make_interval(mins => $5), updated_at = now()
       where ref = $1 and status = 'waiting' returning *`,
      [rows[0].ref, dentist.id, date, time, OFFER_HOLD_MINUTES],
    );
    if (up[0]) {
      await logEvent('waitlist_offered', up[0].ref, 'system',
        `${t.dateLabel(date)} ${t.timeLabel(time)} with ${dentist.name} held for ${up[0].patient_name} (${tierInfo(up[0].tier).label}) for 2 hours`);
    }
    return up[0] || null;
  } catch (e) {
    console.error('offer failed', e.message);
    return null;
  }
}

// ---------- flat fields for the dialogue builder ----------
// Dialogue buttons need simple values, so list endpoints also return the first
// 5 items as flat fields (slot1_id ... slot5_id) plus one numbered text.
const MAX_CHOICES = 5;
function flat(prefix, list, fields, line) {
  const out = { [`${prefix}_choices`]: Math.min(list.length, MAX_CHOICES) };
  const top = list.slice(0, MAX_CHOICES);
  out[`${prefix}_text`] = top.map((x, i) => `${i + 1}. ${line(x)}`).join('\n');
  for (let i = 0; i < MAX_CHOICES; i += 1) {
    const x = top[i];
    for (const [key, get] of Object.entries(fields)) {
      out[`${prefix}${i + 1}${key ? `_${key}` : ''}`] = x ? String(get(x) ?? '') : '';
    }
  }
  return out;
}
const hoursText = (h) => Object.entries(h || {}).map(([k, v]) => `${k} ${v}`).join(', ');
const clinicFlat = (list) => flat('clinic', list, {
  id: (c) => c.id, name: (c) => c.area, address: (c) => c.address, phone: (c) => c.phone, hours: (c) => hoursText(c.hours),
}, (c) => `${c.area} – ${c.address}`);
const dateFlat = (list) => flat('date', list, { '': (d) => d.date, label: (d) => d.label }, (d) => d.label);
const slotFlat = (list, withDate) => flat('slot', list, {
  id: (x) => x.slotId, label: (x) => `${x.dateLabel}, ${x.label} with ${x.dentist}`,
}, (x) => `${withDate ? `${x.dateLabel}, ` : ''}${x.label} – ${x.dentist}`);
const bookingFlat = (list) => flat('booking', list, {
  ref: (b) => b.ref, clinic: (b) => b.clinic.id, service: (b) => b.service.id, summary: (b) => b.summary,
}, (b) => b.summary);

// ---------- app ------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Simple rate limit per client: 300 requests a minute.
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || 'x';
  const h = hits.get(key);
  if (!h || now - h.start > 60000) { hits.set(key, { start: now, n: 1 }); return next(); }
  h.n += 1;
  if (h.n > 300) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please wait a minute.' });
  if (hits.size > 5000) hits.clear();
  return next();
});

app.use(wrap(async (req, res, next) => {
  if (!servicesLoaded && (req.path.startsWith('/api') || req.path.startsWith('/admin'))) await loadServices();
  next();
}));

// ---------- demo website with the Zendesk web widget ----------
// The widget key comes from Zendesk Admin Center > Channels > Messaging >
// your widget > Installation (the part after "key=" in the snippet).
const SITE_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function sitePage() {
  const key = WIDGET_KEY.trim();
  if (/^[A-Za-z0-9-]{8,80}$/.test(key)) {
    return SITE_HTML
      .replace('__WIDGET_NOTICE__', '')
      .replace('__WIDGET_SNIPPET__', `<script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=${key}"></script>`);
  }
  return SITE_HTML
    .replace('__WIDGET_NOTICE__', '<div class="notice">The chat widget is not connected yet. In Render, set <b>ZENDESK_WIDGET_KEY</b> to the key from your Zendesk widget snippet, then redeploy.</div>')
    .replace('__WIDGET_SNIPPET__', '');
}
app.get(['/', '/demo'], (req, res) => res.type('html').send(sitePage()));

app.get('/health', wrap(async (req, res) => {
  const { rows } = await pool.query('select count(*)::int as n from clinics where active');
  res.json({ ok: true, clinics: rows[0].n, time: new Date().toISOString(), timezone: 'Asia/Singapore' });
}));

// ---------- API key check ----------
app.use('/api', (req, res, next) => {
  const key = req.get('X-API-Key') || '';
  const a = Buffer.from(key);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or wrong X-API-Key header' });
  }
  return next();
});

// 1. Services
app.get('/api/services', (req, res) => res.json({ services: SERVICES }));

// 2. Regions
app.get('/api/regions', (req, res) => res.json({ regions: REGIONS }));

// 3. Clinics (list or search)
app.get('/api/clinics', wrap(async (req, res) => {
  const { rows } = await pool.query('select * from clinics where active order by region, area');
  const region = str(req.query.region).toLowerCase();
  const words = str(req.query.q).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const list = rows.filter((c) => {
    if (region && c.region.toLowerCase() !== region) return false;
    const hay = `${c.id} ${c.name} ${c.area} ${c.region} ${c.address}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  res.json({ count: list.length, clinics: list.map(clinicOut), ...clinicFlat(list) });
}));

// 4. One clinic
app.get('/api/clinics/:id', wrap(async (req, res) => {
  res.json(clinicOut(await getClinic(req.params.id)));
}));

// 5. Dentists with open slots (optional ?mobile= shows member priority slots to Gold/Platinum)
app.get('/api/clinics/:id/dentists', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const service = checkService(req.query.service, false);
  const memberRank = await rankFor(req.query.mobile);
  const dentists = await getDentists(clinic.id, { service });
  const booked = await bookedSet(dentists.map((d) => d.id));
  const now = t.nowSG();
  const list = dentists.map((d) => {
    const open = S.openSlots({ dentists: [d], booked, now, memberRank });
    return {
      id: d.id, name: d.name, note: d.note || null, openSlots: open.length,
      nextSlot: open[0] ? { slotId: open[0].slotId, date: open[0].date, time: open[0].time,
        dateLabel: open[0].dateLabel, timeLabel: open[0].timeLabel, memberPriority: open[0].memberPriority } : null,
    };
  }).filter((d) => d.openSlots > 0);
  res.json({ count: list.length, dentists: list });
}));

// 6. Dates with openings
app.get('/api/clinics/:id/dates', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const service = checkService(req.query.service, false);
  const from = req.query.from ? checkDate(req.query.from, 'from') : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 31);
  const memberRank = await rankFor(req.query.mobile);
  const dentists = await getDentists(clinic.id, { service, dentistId: req.query.dentist || null });
  const booked = await bookedSet(dentists.map((d) => d.id));
  const open = S.openSlots({ dentists, booked, from, now: t.nowSG(), memberRank });
  const byDate = new Map();
  for (const s of open) {
    if (!byDate.has(s.date)) byDate.set(s.date, { date: s.date, label: s.dateLabel, openSlots: 0, memberSlots: 0, firstTime: s.timeLabel, dentists: new Set() });
    const d = byDate.get(s.date);
    d.openSlots += 1;
    if (s.memberPriority) d.memberSlots += 1;
    d.dentists.add(s.dentist);
  }
  const dates = [...byDate.values()].slice(0, limit).map((d) => ({ ...d, dentists: [...d.dentists] }));
  res.json({ count: dates.length, dates, ...dateFlat(dates) });
}));

// 7. Times on one date
app.get('/api/clinics/:id/slots', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const date = checkDate(req.query.date);
  const service = checkService(req.query.service, false);
  const dentistId = req.query.dentist || null;
  const period = str(req.query.period).toLowerCase();
  const memberRank = await rankFor(req.query.mobile);
  const dentists = await getDentists(clinic.id, { service, dentistId });
  const booked = await bookedSet(dentists.map((d) => d.id));
  let slots = S.openSlots({ dentists, booked, from: date, to: date, now: t.nowSG(), memberRank });
  if (period === 'morning') slots = slots.filter((s) => s.time < '12:00');
  if (period === 'afternoon') slots = slots.filter((s) => s.time >= '12:00' && s.time < '17:00');
  if (period === 'evening') slots = slots.filter((s) => s.time >= '17:00');
  if (!dentistId) slots = S.onePerTime(slots);
  res.json({ count: slots.length, date, slots, ...slotFlat(slots, false) });
}));

// 8. Earliest open slots
app.get('/api/clinics/:id/next', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const service = checkService(req.query.service, false);
  const dentistId = req.query.dentist || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const memberRank = await rankFor(req.query.mobile);
  const dentists = await getDentists(clinic.id, { service, dentistId });
  const booked = await bookedSet(dentists.map((d) => d.id));
  let slots = S.openSlots({ dentists, booked, now: t.nowSG(), memberRank });
  if (!dentistId) slots = S.onePerTime(slots);
  slots = slots.slice(0, limit);
  res.json({ count: slots.length, slots, ...slotFlat(slots, true) });
}));

// 9. Create a booking request
app.post('/api/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const clinic = await getClinic(str(b.clinicId));
  const service = checkService(b.service, true);
  const name = needName(b.name);
  const mobile = needMobile(b.mobile);
  const email = optEmail(b.email);
  const memberRank = await rankFor(mobile);
  const slot = await claimableSlot({ clinicId: clinic.id, slotIdValue: b.slotId, service, memberRank });
  const row = await insertBooking({
    clinic, service, slot, name, mobile, email,
    notes: str(b.notes, 500), channel: str(b.channel, 50), conversationId: str(b.conversationId, 100), source: 'chat',
  });
  await logEvent('booking_created', row.ref, 'patient', `${name} (${tierInfo(row.tier).label}) booked ${serviceName(service)} on ${t.dateLabel(slot.date)} ${t.timeLabel(slot.time)} with ${slot.dentist.name}`);
  res.status(201).json(bookingOut(row, clinic, slot.dentist));
}));

// 10. A patient's bookings
app.get('/api/bookings', wrap(async (req, res) => {
  const mobile = needMobile(req.query.mobile);
  const all = str(req.query.all).toLowerCase() === 'true';
  const { rows } = await pool.query('select * from bookings where patient_mobile = $1 order by slot_date, slot_time', [mobile]);
  const now = t.nowSG();
  const list = all ? rows : rows.filter((b) => ACTIVE.includes(b.status) && S.isFuture(b.slot_date, b.slot_time, { ...now, minutes: now.minutes - 60 }));
  const L = await lookups();
  const bookings = list.map((b) => bookingOut(b, L.clinics.get(b.clinic_id), L.dentists.get(b.dentist_id)));
  res.json({ count: bookings.length, bookings, ...bookingFlat(bookings) });
}));

// 11. One booking
app.get('/api/bookings/:ref', wrap(async (req, res) => {
  const b = await loadBooking(req.params.ref, req.query.mobile);
  res.json(await expandBooking(b));
}));

async function doReschedule(b, slotIdValue, memberRank, actor) {
  const slot = await claimableSlot({ clinicId: b.clinic_id, slotIdValue, service: b.service, ignoreRef: b.ref, memberRank });
  let rows;
  try {
    ({ rows } = await pool.query(
      `update bookings set dentist_id = $2, slot_date = $3, slot_time = $4, status = 'requested',
         reschedule_count = reschedule_count + 1, updated_at = now() where ref = $1 returning *`,
      [b.ref, slot.dentist.id, slot.date, slot.time],
    ));
  } catch (e) {
    if (e.code === '23505') fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
    throw e;
  }
  await logEvent('booking_rescheduled', b.ref, actor, `Moved from ${t.dateLabel(b.slot_date)} ${t.timeLabel(b.slot_time)} to ${t.dateLabel(slot.date)} ${t.timeLabel(slot.time)} with ${slot.dentist.name}`);
  await offerFreedSlot(b.dentist_id, b.slot_date, b.slot_time);
  return rows[0];
}

async function doCancel(b, status, reason, actor) {
  const { rows } = await pool.query(
    `update bookings set status = $2, cancel_reason = coalesce($3, cancel_reason), updated_at = now()
      where ref = $1 returning *`,
    [b.ref, status, reason || null],
  );
  await logEvent(status === 'rejected' ? 'booking_declined' : 'booking_cancelled', b.ref, actor,
    `${b.patient_name}: ${t.dateLabel(b.slot_date)} ${t.timeLabel(b.slot_time)}${reason ? ` (${reason})` : ''}`);
  if (ACTIVE.includes(b.status)) await offerFreedSlot(b.dentist_id, b.slot_date, b.slot_time);
  return rows[0];
}

// 12. Reschedule
app.post('/api/bookings/:ref/reschedule', wrap(async (req, res) => {
  const body = req.body || {};
  const b = await loadBooking(req.params.ref, body.mobile);
  if (!isChangeable(b)) notChangeable(b);
  const row = await doReschedule(b, body.slotId, await rankFor(b.patient_mobile), 'patient');
  res.json(await expandBooking(row));
}));

// 13. Cancel
app.post('/api/bookings/:ref/cancel', wrap(async (req, res) => {
  const body = req.body || {};
  const b = await loadBooking(req.params.ref, body.mobile);
  if (!isChangeable(b)) notChangeable(b);
  const row = await doCancel(b, 'cancelled', str(body.reason, 300), 'patient');
  res.json(await expandBooking(row));
}));

// 14. Patient lookup: membership tier, perks and the priority to give in Zendesk
app.get('/api/patients/lookup', wrap(async (req, res) => {
  const mobile = needMobile(req.query.mobile);
  const p = await getPatient(mobile);
  const tierId = p ? p.tier : 'standard';
  const tier = tierInfo(tierId);
  const [{ rows: up }, { rows: wl }] = await Promise.all([
    pool.query('select count(*)::int as n from bookings where patient_mobile = $1 and status = any($2) and slot_date >= $3', [mobile, ACTIVE, t.nowSG().date]),
    pool.query("select count(*)::int as n from waitlist where patient_mobile = $1 and status in ('waiting','offered')", [mobile]),
  ]);
  const first = p ? p.name.split(/\s+/)[0] : '';
  let greeting = 'Welcome to ZenAura Dental!';
  if (p && tier.rank > 0) greeting = `Welcome back, ${p.name}! As a ${tier.label} member you get: ${tier.perks.join('; ')}.`;
  else if (p) greeting = `Welcome back, ${p.name}!`;
  res.json({
    found: !!p,
    mobile,
    name: p ? p.name : null,
    firstName: first || null,
    tier: tierId,
    tierLabel: tier.label,
    isMember: tier.rank > 0,
    priorityRank: tier.rank,
    ticketPriority: tier.ticketPriority,
    zendeskTag: `member_${tierId}`,
    perks: tier.perks,
    perksText: tier.perks.join('; '),
    memberSince: p ? p.member_since : null,
    upcomingBookings: up[0].n,
    waitlistEntries: wl[0].n,
    greeting,
  });
}));

async function addToWaitlist(b, actor) {
  const clinic = await getClinic(str(b.clinicId));
  const service = checkService(b.service, true);
  const name = needName(b.name);
  const mobile = needMobile(b.mobile);
  let dentistId = str(b.dentistId || b.dentist, 20) || null;
  if (dentistId) {
    const ds = await getDentists(clinic.id, { service, dentistId });
    if (!ds[0]) fail(400, 'invalid_dentist', 'That dentist does not offer this service at this clinic. Leave it empty for any dentist.');
    dentistId = ds[0].id;
  }
  const fromDate = b.fromDate ? checkDate(b.fromDate, 'from') : null;
  const { rows: existing } = await pool.query(
    "select * from waitlist where patient_mobile = $1 and clinic_id = $2 and service = $3 and status in ('waiting','offered')",
    [mobile, clinic.id, service],
  );
  if (existing[0]) return { row: existing[0], created: false };
  const patient = await upsertPatient(mobile, name, null);
  const tier = tierInfo(patient.tier);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `insert into waitlist (ref, clinic_id, service, dentist_id, from_date, patient_name, patient_mobile, tier, priority, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [randomCode('WL-'), clinic.id, service, dentistId, fromDate, name, mobile, patient.tier, tier.rank, str(b.notes, 300) || null],
      );
      await logEvent('waitlist_joined', rows[0].ref, actor, `${name} (${tier.label}) joined the waitlist for ${serviceName(service)} at ${clinic.area}`);
      return { row: rows[0], created: true };
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  return fail(500, 'server_error', 'Could not add to the waitlist. Please try again.');
}

// 15. Join the waitlist
app.post('/api/waitlist', wrap(async (req, res) => {
  const { row, created } = await addToWaitlist(req.body || {}, 'patient');
  const out = waitlistOut(row, await waitPositions(), await lookups());
  res.status(created ? 201 : 200).json({ ...out, alreadyOnWaitlist: !created });
}));

// 16. A patient's waitlist entries (and any slot held for them)
app.get('/api/waitlist', wrap(async (req, res) => {
  const mobile = needMobile(req.query.mobile);
  await expireOffers();
  const { rows } = await pool.query(
    "select * from waitlist where patient_mobile = $1 and status in ('waiting','offered') order by created_at", [mobile],
  );
  const pos = await waitPositions();
  const L = await lookups();
  const entries = rows.map((w) => waitlistOut(w, pos, L));
  const offered = entries.filter((e) => e.offer);
  res.json({
    count: entries.length,
    offers: offered.length,
    offer_ref: offered[0] ? offered[0].ref : '',
    offer_summary: offered[0] ? offered[0].summary : '',
    entries,
    summary: entries.length ? entries.map((e) => e.summary).join(' ') : 'You are not on any waitlist.',
  });
}));

async function loadWait(ref, mobile) {
  const m = normMobile(mobile);
  const { rows } = await pool.query('select * from waitlist where upper(ref) = upper($1)', [str(ref, 20)]);
  if (!rows[0] || (mobile !== undefined && rows[0].patient_mobile !== m)) {
    fail(404, 'waitlist_not_found', 'We could not find a waitlist entry with that reference and mobile number.');
  }
  return rows[0];
}

async function bookFromWaitlist(w, slotIdValue, actor) {
  const clinic = await getClinic(w.clinic_id);
  const slot = await claimableSlot({ clinicId: w.clinic_id, slotIdValue, service: w.service, ignoreWaitRef: w.ref, memberRank: 99 });
  const { rows: pr } = await pool.query('select email from patients where mobile = $1', [w.patient_mobile]);
  const row = await insertBooking({
    clinic, service: w.service, slot, name: w.patient_name, mobile: w.patient_mobile,
    email: pr[0] ? pr[0].email : null, notes: w.notes, source: 'waitlist',
  });
  await pool.query("update waitlist set status = 'booked', booking_ref = $2, updated_at = now() where ref = $1", [w.ref, row.ref]);
  await logEvent('waitlist_booked', w.ref, actor, `${w.patient_name} booked ${row.ref} for ${t.dateLabel(slot.date)} ${t.timeLabel(slot.time)}`);
  return { row, clinic, slot };
}

// 17. Accept the slot held for you
app.post('/api/waitlist/:ref/accept', wrap(async (req, res) => {
  const body = req.body || {};
  await expireOffers();
  const w = await loadWait(req.params.ref, body.mobile === undefined ? '' : body.mobile);
  if (w.status !== 'offered') fail(409, 'offer_not_available', 'There is no slot held for this waitlist entry right now. You keep your place on the waitlist.');
  const { row, clinic, slot } = await bookFromWaitlist(w, S.slotId(w.offered_date, w.offered_time, w.offered_dentist_id), 'patient');
  res.status(201).json({ ...bookingOut(row, clinic, slot.dentist), waitlistRef: w.ref });
}));

// 18. Leave the waitlist
app.post('/api/waitlist/:ref/cancel', wrap(async (req, res) => {
  const body = req.body || {};
  const w = await loadWait(req.params.ref, body.mobile === undefined ? '' : body.mobile);
  if (!['waiting', 'offered'].includes(w.status)) fail(409, 'not_changeable', 'This waitlist entry is already closed.');
  const { rows } = await pool.query("update waitlist set status = 'removed', updated_at = now() where ref = $1 returning *", [w.ref]);
  await logEvent('waitlist_removed', w.ref, 'patient', `${w.patient_name} left the waitlist`);
  if (w.status === 'offered') await offerFreedSlot(w.offered_dentist_id, w.offered_date, w.offered_time);
  res.json(waitlistOut(rows[0], await waitPositions(), await lookups()));
}));

// =====================================================================
// Staff console (/admin) - login with any username and ADMIN_PASSWORD
// =====================================================================
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Set ADMIN_PASSWORD to use the staff console.');
  const h = req.get('Authorization') || '';
  const pass = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="ZenAura staff"');
  return res.status(401).send('Login required');
}

app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use('/admin/api', adminAuth);

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
}

function checkSchedule(input) {
  const out = {};
  const obj = input && typeof input === 'object' ? input : {};
  for (const [day, blocks] of Object.entries(obj)) {
    if (!/^[1-7]$/.test(day)) fail(400, 'invalid_schedule', 'Schedule days must be 1 (Mon) to 7 (Sun).');
    if (!Array.isArray(blocks)) fail(400, 'invalid_schedule', 'Each day needs a list of [start, end] times.');
    const clean = [];
    for (const blk of blocks) {
      const [s, e] = Array.isArray(blk) ? blk : [];
      const ok = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):(00|30)$/.test(v);
      if (!ok(s) || !ok(e) || t.toMinutes(s) >= t.toMinutes(e)) {
        fail(400, 'invalid_schedule', 'Working hours must be on the hour or half hour, and start before end (e.g. 09:00 to 13:00).');
      }
      clean.push([s, e]);
    }
    clean.sort((x, y) => x[0].localeCompare(y[0]));
    for (let i = 1; i < clean.length; i += 1) {
      if (clean[i][0] < clean[i - 1][1]) fail(400, 'invalid_schedule', 'Working hours on the same day must not overlap.');
    }
    if (clean.length) out[day] = clean.slice(0, 4);
  }
  return out;
}

function checkServices(list) {
  const arr = (Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase());
  const valid = arr.filter((x) => SERVICE_NAMES[x]);
  if (!valid.length) fail(400, 'invalid_service', 'Choose at least one service.');
  return [...new Set(valid)];
}

function checkHours(input) {
  const out = {};
  for (const k of DAY_KEYS) out[k] = str(input && input[k], 40) || 'Closed';
  return out;
}

// --- meta and dashboard ---
app.get('/admin/api/meta', wrap(async (req, res) => {
  const [{ rows: clinics }, { rows: dentists }, { rows: services }] = await Promise.all([
    pool.query('select * from clinics order by region, area'),
    pool.query('select * from dentists order by clinic_id, name'),
    pool.query('select * from services order by sort, name'),
  ]);
  res.json({
    regions: REGIONS,
    tiers: TIER_IDS.map((id) => ({ id, ...TIERS[id] })),
    services,
    clinics: clinics.map((c) => ({ ...clinicOut(c), active: c.active })),
    dentists: dentists.map((d) => ({ id: d.id, clinicId: d.clinic_id, name: d.name, note: d.note, services: d.services, schedule: d.schedule, active: d.active })),
    rules: {
      memberSlots: `First ${S.PRIORITY_SLOTS_PER_DAY} slots of each dentist's day are held for Gold and Platinum members until ${S.HOLD_HOURS} hours before.`,
      offerHold: `A freed slot is held for the next waitlisted patient for ${OFFER_HOLD_MINUTES / 60} hours.`,
    },
  });
}));

app.get('/admin/api/summary', wrap(async (req, res) => {
  await expireOffers();
  const today = t.nowSG().date;
  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
  const [todayRows, pending, upcoming, waiting, offers, tiers, recent] = await Promise.all([
    q('select count(*)::int as n from bookings where slot_date = $1 and status = any($2)', [today, ACTIVE]),
    q("select count(*)::int as n from bookings where status = 'requested' and slot_date >= $1", [today]),
    q("select count(*)::int as n from bookings where status = 'confirmed' and slot_date >= $1", [today]),
    q("select count(*)::int as n from waitlist where status = 'waiting'"),
    q("select count(*)::int as n from waitlist where status = 'offered'"),
    q('select tier, count(*)::int as n from patients group by tier'),
    q("select count(*)::int as n from bookings where created_at > now() - interval '7 days'"),
  ]);
  const members = Object.fromEntries(TIER_IDS.map((id) => [id, 0]));
  for (const r of tiers) members[r.tier] = r.n;
  res.json({
    today, todayAppointments: todayRows[0].n, pending: pending[0].n, upcomingConfirmed: upcoming[0].n,
    waitlistWaiting: waiting[0].n, offersOpen: offers[0].n, members, bookingsLast7Days: recent[0].n,
  });
}));

app.get('/admin/api/events', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const { rows } = await pool.query('select * from events order by id desc limit $1', [limit]);
  res.json({ count: rows.length, events: rows.map((e) => ({ ...e, at: new Date(e.at).toISOString() })) });
}));

// --- bookings ---
app.get('/admin/api/bookings', wrap(async (req, res) => {
  const { rows } = await pool.query('select * from bookings order by created_at desc limit 300');
  const L = await lookups();
  const out = rows.map((b) => bookingOut(b, L.clinics.get(b.clinic_id), L.dentists.get(b.dentist_id)));
  res.json({ count: out.length, bookings: out });
}));

// Open slots for the staff booking form (staff see member priority slots too)
app.get('/admin/api/slots', wrap(async (req, res) => {
  const clinic = await getClinic(str(req.query.clinicId));
  const service = checkService(req.query.service, true);
  const date = req.query.date ? checkDate(req.query.date) : null;
  const dentists = await getDentists(clinic.id, { service, dentistId: req.query.dentist || null });
  const booked = await bookedSet(dentists.map((d) => d.id));
  let slots = S.openSlots({ dentists, booked, from: date, to: date, now: t.nowSG(), memberRank: 99 });
  if (!date) slots = slots.slice(0, 40);
  res.json({ count: slots.length, slots });
}));

app.post('/admin/api/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const clinic = await getClinic(str(b.clinicId));
  const service = checkService(b.service, true);
  const name = needName(b.name);
  const mobile = needMobile(b.mobile);
  const email = optEmail(b.email);
  const slot = await claimableSlot({ clinicId: clinic.id, slotIdValue: b.slotId, service, memberRank: 99 });
  const row = await insertBooking({
    clinic, service, slot, name, mobile, email, notes: str(b.notes, 500), channel: 'staff console', source: 'staff',
  });
  let final = row;
  if (b.confirm) {
    ({ rows: [final] } = await pool.query("update bookings set status = 'confirmed', updated_at = now() where ref = $1 returning *", [row.ref]));
  }
  await logEvent('booking_created', row.ref, 'staff', `Staff booked ${name} (${tierInfo(row.tier).label}) for ${serviceName(service)} on ${t.dateLabel(slot.date)} ${t.timeLabel(slot.time)} with ${slot.dentist.name}`);
  res.status(201).json(bookingOut(final, clinic, slot.dentist));
}));

async function adminBooking(ref) {
  const { rows } = await pool.query('select * from bookings where upper(ref) = upper($1)', [str(ref, 20)]);
  if (!rows[0]) fail(404, 'booking_not_found', 'No booking with that reference.');
  return rows[0];
}

app.post('/admin/api/bookings/:ref/reschedule', wrap(async (req, res) => {
  const b = await adminBooking(req.params.ref);
  if (!isChangeable(b)) notChangeable(b);
  const row = await doReschedule(b, (req.body || {}).slotId, 99, 'staff');
  res.json(await expandBooking(row));
}));

app.post('/admin/api/bookings/:ref/:action', wrap(async (req, res) => {
  const action = req.params.action;
  if (!['confirm', 'reject', 'cancel'].includes(action)) fail(404, 'not_found', 'Unknown action');
  const b = await adminBooking(req.params.ref);
  let row;
  if (action === 'confirm') {
    if (b.status !== 'requested') fail(409, 'not_changeable', 'Only pending requests can be confirmed.');
    ({ rows: [row] } = await pool.query("update bookings set status = 'confirmed', updated_at = now() where ref = $1 returning *", [b.ref]));
    await logEvent('booking_confirmed', b.ref, 'staff', `${b.patient_name}: ${t.dateLabel(b.slot_date)} ${t.timeLabel(b.slot_time)}`);
  } else {
    if (!ACTIVE.includes(b.status)) fail(409, 'not_changeable', 'This booking is already closed.');
    row = await doCancel(b, action === 'reject' ? 'rejected' : 'cancelled', str((req.body || {}).reason, 300), 'staff');
  }
  res.json(await expandBooking(row));
}));

app.post('/admin/api/reset', wrap(async (req, res) => {
  const r = await pool.query('delete from bookings');
  await pool.query('delete from waitlist');
  await pool.query('delete from events');
  await logEvent('reset', null, 'staff', `Cleared ${r.rowCount} bookings and the waitlist for a fresh demo`);
  res.json({ ok: true, deleted: r.rowCount });
}));

// --- waitlist ---
app.get('/admin/api/waitlist', wrap(async (req, res) => {
  await expireOffers();
  const { rows } = await pool.query(
    `select * from waitlist order by case status when 'offered' then 0 when 'waiting' then 1 else 2 end,
       priority desc, created_at limit 300`,
  );
  const pos = await waitPositions();
  const L = await lookups();
  res.json({ count: rows.length, entries: rows.map((w) => waitlistOut(w, pos, L)) });
}));

app.post('/admin/api/waitlist', wrap(async (req, res) => {
  const { row, created } = await addToWaitlist(req.body || {}, 'staff');
  res.status(created ? 201 : 200).json({ ...waitlistOut(row, await waitPositions(), await lookups()), alreadyOnWaitlist: !created });
}));

app.post('/admin/api/waitlist/:ref/:action', wrap(async (req, res) => {
  const { action } = req.params;
  await expireOffers();
  const w = await loadWait(req.params.ref);
  const body = req.body || {};
  if (action === 'remove') {
    if (!['waiting', 'offered'].includes(w.status)) fail(409, 'not_changeable', 'This waitlist entry is already closed.');
    await pool.query("update waitlist set status = 'removed', updated_at = now() where ref = $1", [w.ref]);
    await logEvent('waitlist_removed', w.ref, 'staff', `Staff removed ${w.patient_name} from the waitlist`);
    if (w.status === 'offered') await offerFreedSlot(w.offered_dentist_id, w.offered_date, w.offered_time);
    return res.json({ ok: true });
  }
  if (action === 'offer') {
    if (w.status !== 'waiting') fail(409, 'not_changeable', 'Only waiting entries can be offered a slot.');
    const slot = await claimableSlot({ clinicId: w.clinic_id, slotIdValue: body.slotId, service: w.service, memberRank: 99 });
    await pool.query(
      `update waitlist set status = 'offered', offered_dentist_id = $2, offered_date = $3, offered_time = $4,
         offer_expires = now() + make_interval(mins => $5), updated_at = now() where ref = $1`,
      [w.ref, slot.dentist.id, slot.date, slot.time, OFFER_HOLD_MINUTES],
    );
    await logEvent('waitlist_offered', w.ref, 'staff', `Staff held ${t.dateLabel(slot.date)} ${t.timeLabel(slot.time)} with ${slot.dentist.name} for ${w.patient_name}`);
    return res.json({ ok: true });
  }
  if (action === 'book') {
    if (!['waiting', 'offered'].includes(w.status)) fail(409, 'not_changeable', 'This waitlist entry is already closed.');
    const slotIdValue = w.status === 'offered' ? S.slotId(w.offered_date, w.offered_time, w.offered_dentist_id) : body.slotId;
    const { row, clinic, slot } = await bookFromWaitlist(w, slotIdValue, 'staff');
    return res.status(201).json(bookingOut(row, clinic, slot.dentist));
  }
  return fail(404, 'not_found', 'Unknown action');
}));

// --- patients and members ---
app.get('/admin/api/patients', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `select p.*, (select count(*)::int from bookings b where b.patient_mobile = p.mobile) as bookings,
            (select max(b.slot_date) from bookings b where b.patient_mobile = p.mobile and b.status = any($1)) as last_visit
       from patients p order by case tier when 'platinum' then 0 when 'gold' then 1 when 'silver' then 2 else 3 end, name`,
    [ACTIVE],
  );
  res.json({
    count: rows.length,
    patients: rows.map((p) => ({
      mobile: p.mobile, name: p.name, email: p.email, tier: p.tier, tierLabel: tierInfo(p.tier).label,
      preferredClinic: p.preferred_clinic, notes: p.notes, memberSince: p.member_since,
      bookings: p.bookings, lastVisit: p.last_visit,
    })),
  });
}));

// Create or update a patient (by mobile)
app.post('/admin/api/patients', wrap(async (req, res) => {
  const b = req.body || {};
  const mobile = needMobile(b.mobile);
  const name = needName(b.name);
  const email = optEmail(b.email);
  const tier = str(b.tier).toLowerCase() || 'standard';
  if (!TIERS[tier]) fail(400, 'invalid_tier', `Tier must be one of: ${TIER_IDS.join(', ')}.`);
  const preferred = str(b.preferredClinic) || null;
  if (preferred) await getClinic(preferred, true);
  const before = await getPatient(mobile);
  const { rows } = await pool.query(
    `insert into patients (mobile, name, email, tier, preferred_clinic, notes)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (mobile) do update set name = excluded.name, email = excluded.email, tier = excluded.tier,
       preferred_clinic = excluded.preferred_clinic, notes = excluded.notes, updated_at = now()
     returning *`,
    [mobile, name, email, tier, preferred, str(b.notes, 300) || null],
  );
  // Keep open waitlist entries in line with the new tier.
  await pool.query("update waitlist set tier = $2, priority = $3 where patient_mobile = $1 and status in ('waiting','offered')",
    [mobile, tier, TIERS[tier].rank]);
  const change = before && before.tier !== tier ? ` (tier ${tierInfo(before.tier).label} → ${TIERS[tier].label})` : '';
  await logEvent(before ? 'patient_updated' : 'patient_added', mobile, 'staff', `${name}${before ? change : ` added as ${TIERS[tier].label}`}`);
  res.status(before ? 200 : 201).json({ ok: true, patient: rows[0] });
}));

// --- doctors ---
app.post('/admin/api/dentists', wrap(async (req, res) => {
  const b = req.body || {};
  const clinic = await getClinic(str(b.clinicId), true);
  const name = needName(b.name);
  const services = checkServices(b.services);
  const schedule = checkSchedule(b.schedule);
  let id;
  for (let i = 0; i < 10; i += 1) {
    id = `d${crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await pool.query('select 1 from dentists where id = $1', [id]);
    if (!rows.length) break;
  }
  const { rows } = await pool.query(
    'insert into dentists (id, clinic_id, name, note, services, schedule, active) values ($1,$2,$3,$4,$5,$6,$7) returning *',
    [id, clinic.id, name, str(b.note, 100) || null, services, schedule, b.active !== false],
  );
  await logEvent('dentist_added', id, 'staff', `${name} added at ${clinic.area}`);
  res.status(201).json({ ok: true, dentist: rows[0] });
}));

app.post('/admin/api/dentists/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const { rows: cur } = await pool.query('select * from dentists where id = $1', [req.params.id]);
  if (!cur[0]) fail(404, 'dentist_not_found', 'No dentist with that id.');
  const clinic = await getClinic(str(b.clinicId) || cur[0].clinic_id, true);
  const name = b.name !== undefined ? needName(b.name) : cur[0].name;
  const services = b.services !== undefined ? checkServices(b.services) : cur[0].services;
  const schedule = b.schedule !== undefined ? checkSchedule(b.schedule) : cur[0].schedule;
  const active = b.active !== undefined ? !!b.active : cur[0].active;
  const note = b.note !== undefined ? (str(b.note, 100) || null) : cur[0].note;
  const { rows } = await pool.query(
    'update dentists set clinic_id = $2, name = $3, note = $4, services = $5, schedule = $6, active = $7 where id = $1 returning *',
    [cur[0].id, clinic.id, name, note, services, schedule, active],
  );
  await logEvent('dentist_updated', cur[0].id, 'staff', `${name} updated${active ? '' : ' (inactive)'}`);
  res.json({ ok: true, dentist: rows[0] });
}));

// --- clinics ---
app.post('/admin/api/clinics', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 100);
  const area = str(b.area, 60);
  const address = str(b.address, 200);
  if (name.length < 3 || area.length < 2 || address.length < 5) fail(400, 'invalid_clinic', 'Name, area and address are required.');
  if (!REGIONS.includes(b.region)) fail(400, 'invalid_region', `Region must be one of: ${REGIONS.join(', ')}.`);
  let id = slugify(area);
  const { rows: ex } = await pool.query('select id from clinics where id like $1', [`${id}%`]);
  if (ex.some((r) => r.id === id)) id = `${id}-${ex.length + 1}`;
  const { rows } = await pool.query(
    'insert into clinics (id, name, area, region, address, phone, hours, maps_url, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',
    [id, name, area, b.region, address, str(b.phone, 30) || null, checkHours(b.hours),
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`, b.active !== false],
  );
  await logEvent('clinic_added', id, 'staff', `${name} added`);
  res.status(201).json({ ok: true, clinic: clinicOut(rows[0]) });
}));

app.post('/admin/api/clinics/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const c = await getClinic(req.params.id, true);
  const region = b.region !== undefined ? b.region : c.region;
  if (!REGIONS.includes(region)) fail(400, 'invalid_region', `Region must be one of: ${REGIONS.join(', ')}.`);
  const name = b.name !== undefined ? str(b.name, 100) : c.name;
  const area = b.area !== undefined ? str(b.area, 60) : c.area;
  const address = b.address !== undefined ? str(b.address, 200) : c.address;
  if (name.length < 3 || area.length < 2 || address.length < 5) fail(400, 'invalid_clinic', 'Name, area and address are required.');
  const { rows } = await pool.query(
    'update clinics set name = $2, area = $3, region = $4, address = $5, phone = $6, hours = $7, active = $8 where id = $1 returning *',
    [c.id, name, area, region, address, b.phone !== undefined ? (str(b.phone, 30) || null) : c.phone,
      b.hours !== undefined ? checkHours(b.hours) : c.hours, b.active !== undefined ? !!b.active : c.active],
  );
  await logEvent('clinic_updated', c.id, 'staff', `${name} updated${rows[0].active ? '' : ' (inactive)'}`);
  res.json({ ok: true, clinic: clinicOut(rows[0]) });
}));

// --- services ---
app.post('/admin/api/services', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 60);
  if (name.length < 3) fail(400, 'invalid_service', 'Give the service a name (3 to 60 characters).');
  const id = slugify(b.id || name).replace(/-/g, '_').slice(0, 30);
  const { rows: ex } = await pool.query('select 1 from services where id = $1', [id]);
  if (ex.length) fail(409, 'service_exists', `A service with id "${id}" already exists.`);
  await pool.query('insert into services (id, name, sort) values ($1, $2, (select coalesce(max(sort), 0) + 10 from services))', [id, name]);
  await loadServices();
  await logEvent('service_added', id, 'staff', `Service "${name}" added. Assign it to dentists to make it bookable.`);
  res.status(201).json({ ok: true, id });
}));

app.post('/admin/api/services/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const { rows: cur } = await pool.query('select * from services where id = $1', [req.params.id]);
  if (!cur[0]) fail(404, 'service_not_found', 'No service with that id.');
  const name = b.name !== undefined ? str(b.name, 60) : cur[0].name;
  if (name.length < 3) fail(400, 'invalid_service', 'Give the service a name (3 to 60 characters).');
  const active = b.active !== undefined ? !!b.active : cur[0].active;
  await pool.query('update services set name = $2, active = $3 where id = $1', [cur[0].id, name, active]);
  await loadServices();
  await logEvent('service_updated', cur[0].id, 'staff', `Service "${name}" ${active ? 'updated' : 'switched off'}`);
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: 'not_found', message: 'No such endpoint.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
  console.error(err);
  return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`ZenAura booking API listening on port ${PORT}`));
}

module.exports = { app, pool };
