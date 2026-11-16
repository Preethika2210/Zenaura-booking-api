// ZenAura Dental booking API (demo).
// Same endpoints and responses as the customer's POC, backed by Postgres.
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

if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!API_KEY) { console.error('API_KEY is not set'); process.exit(1); }

const local = /localhost|127\.0\.0\.1|\/var\/run|\/tmp\//.test(DATABASE_URL) || DATABASE_URL.includes('host=/');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 5,
});

// ---------- reference data ------------------------------------------
const SERVICES = [
  { id: 'consult', name: 'General consultation' },
  { id: 'cleaning', name: 'Scaling & polishing (cleaning)' },
  { id: 'filling', name: 'Simple filling' },
];
const SERVICE_IDS = SERVICES.map((s) => s.id);
const REGIONS = ['Central', 'East', 'North', 'North-East', 'West'];
const STATUS_LABEL = {
  requested: 'Pending clinic confirmation',
  confirmed: 'Confirmed',
  rejected: 'Declined by clinic',
  cancelled: 'Cancelled',
};
const ACTIVE = ['requested', 'confirmed'];

// ---------- helpers --------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function normMobile(input) {
  if (input === undefined || input === null) return null;
  const digits = String(input).replace(/[^\d]/g, '');
  let local8 = digits;
  if (digits.length === 10 && digits.startsWith('65')) local8 = digits.slice(2);
  if (!/^[3689]\d{7}$/.test(local8)) return null;
  return `+65${local8}`;
}

function checkService(s, required) {
  if (s === undefined || s === null || s === '') {
    if (required) fail(400, 'invalid_service', 'Please choose a service: consultation, cleaning or filling.');
    return null;
  }
  const v = String(s).trim().toLowerCase();
  if (!SERVICE_IDS.includes(v)) fail(400, 'invalid_service', 'Please choose a service: consultation, cleaning or filling.');
  return v;
}

function checkDate(s, field = 'date') {
  if (!t.isValidDate(String(s || '').trim())) fail(400, 'invalid_date', `Please give the ${field === 'from' ? 'start date' : 'date'} as YYYY-MM-DD.`);
  return String(s).trim();
}

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
  const service = SERVICES.find((s) => s.id === b.service);
  const date = t.isValidDate(b.slot_date) ? b.slot_date : new Date(b.slot_date).toISOString().slice(0, 10);
  const dl = t.dateLabel(date);
  const tl = t.timeLabel(b.slot_time);
  return {
    ref: b.ref,
    status: b.status,
    statusLabel: STATUS_LABEL[b.status],
    clinic: { id: clinic.id, name: clinic.name, address: clinic.address, phone: clinic.phone },
    service: { id: service.id, name: service.name },
    dentist: dentist.name,
    date,
    time: b.slot_time,
    dateLabel: dl,
    timeLabel: tl,
    patient: { name: b.patient_name, mobile: b.patient_mobile, email: b.patient_email },
    notes: b.notes,
    rescheduleCount: b.reschedule_count,
    channel: b.channel,
    conversationId: b.conversation_id,
    createdAt: new Date(b.created_at).toISOString(),
    updatedAt: new Date(b.updated_at).toISOString(),
    cardTitle: service.name,
    cardDescription: `${dl}, ${tl} · ${clinic.area} · ${dentist.name}`,
    summary: `${b.ref}: ${service.name} at ${clinic.name} with ${dentist.name} on ${dl} at ${tl}. Status: ${STATUS_LABEL[b.status]}.`,
  };
}

// Keep the date column as text YYYY-MM-DD (avoids time zone shifts in pg).
const pgTypes = require('pg').types;
pgTypes.setTypeParser(1082, (v) => v);

async function getClinic(id) {
  const { rows } = await pool.query('select * from clinics where id = $1 and active', [id]);
  if (!rows[0]) fail(404, 'clinic_not_found', `No clinic with id "${id}". Use the clinics list for valid ids.`);
  return rows[0];
}

async function getDentists(clinicId, { service, dentistId } = {}) {
  const { rows } = await pool.query(
    'select * from dentists where clinic_id = $1 and active order by id', [clinicId],
  );
  return rows.filter((d) => (!service || d.services.includes(service))
    && (!dentistId || d.id.toLowerCase() === String(dentistId).toLowerCase()));
}

async function bookedSet(dentistIds) {
  if (!dentistIds.length) return new Set();
  const { rows } = await pool.query(
    `select dentist_id, slot_date, slot_time from bookings
      where dentist_id = any($1) and status = any($2) and slot_date >= $3`,
    [dentistIds, ACTIVE, t.nowSG().date],
  );
  return new Set(rows.map((r) => `${r.dentist_id}|${r.slot_date}|${r.slot_time}`));
}

async function loadBooking(ref, mobile) {
  const m = normMobile(mobile);
  const { rows } = await pool.query('select * from bookings where upper(ref) = upper($1)', [String(ref || '').trim()]);
  const b = rows[0];
  if (!b || !m || b.patient_mobile !== m) {
    fail(404, 'booking_not_found', 'We could not find a booking with that reference and mobile number. Please check both.');
  }
  return b;
}

async function expandBooking(b) {
  const [{ rows: c }, { rows: d }] = await Promise.all([
    pool.query('select * from clinics where id = $1', [b.clinic_id]),
    pool.query('select * from dentists where id = $1', [b.dentist_id]),
  ]);
  return bookingOut(b, c[0], d[0]);
}

function newRef() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = 'ZD-';
  for (let i = 0; i < 4; i += 1) s += letters[crypto.randomInt(letters.length)];
  return s;
}

function isChangeable(b) {
  return ACTIVE.includes(b.status) && S.isFuture(b.slot_date, b.slot_time, t.nowSG());
}

function notChangeable(b) {
  if (b.status === 'cancelled') fail(409, 'not_changeable', "This booking is cancelled and can't be changed.");
  if (b.status === 'rejected') fail(409, 'not_changeable', "This booking was declined by the clinic and can't be changed.");
  fail(409, 'not_changeable', "This booking time has passed and can't be changed.");
}

// ---------- app ------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

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
  const region = String(req.query.region || '').trim().toLowerCase();
  const words = String(req.query.q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const list = rows.filter((c) => {
    if (region && c.region.toLowerCase() !== region) return false;
    const hay = `${c.id} ${c.name} ${c.area} ${c.region} ${c.address}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  res.json({ count: list.length, clinics: list.map(clinicOut) });
}));

// 4. One clinic
app.get('/api/clinics/:id', wrap(async (req, res) => {
  res.json(clinicOut(await getClinic(req.params.id)));
}));

// 5. Dentists with open slots
app.get('/api/clinics/:id/dentists', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const service = checkService(req.query.service, false);
  const dentists = await getDentists(clinic.id, { service });
  const booked = await bookedSet(dentists.map((d) => d.id));
  const now = t.nowSG();
  const list = dentists.map((d) => {
    const open = S.openSlots({ dentists: [d], booked, now });
    return {
      id: d.id, name: d.name, note: d.note || null, openSlots: open.length,
      nextSlot: open[0] ? { slotId: open[0].slotId, date: open[0].date, time: open[0].time,
        dateLabel: open[0].dateLabel, timeLabel: open[0].timeLabel } : null,
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
  const dentists = await getDentists(clinic.id, { service, dentistId: req.query.dentist || null });
  const booked = await bookedSet(dentists.map((d) => d.id));
  const open = S.openSlots({ dentists, booked, from, now: t.nowSG() });
  const byDate = new Map();
  for (const s of open) {
    if (!byDate.has(s.date)) byDate.set(s.date, { date: s.date, label: s.dateLabel, openSlots: 0, firstTime: s.timeLabel, dentists: new Set() });
    const d = byDate.get(s.date);
    d.openSlots += 1;
    d.dentists.add(s.dentist);
  }
  const dates = [...byDate.values()].slice(0, limit).map((d) => ({ ...d, dentists: [...d.dentists] }));
  res.json({ count: dates.length, dates });
}));

// 7. Times on one date
app.get('/api/clinics/:id/slots', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const date = checkDate(req.query.date);
  const service = checkService(req.query.service, false);
  const dentistId = req.query.dentist || null;
  const period = String(req.query.period || '').toLowerCase();
  const dentists = await getDentists(clinic.id, { service, dentistId });
  const booked = await bookedSet(dentists.map((d) => d.id));
  let slots = S.openSlots({ dentists, booked, from: date, to: date, now: t.nowSG() });
  if (period === 'morning') slots = slots.filter((s) => s.time < '12:00');
  if (period === 'afternoon') slots = slots.filter((s) => s.time >= '12:00' && s.time < '17:00');
  if (period === 'evening') slots = slots.filter((s) => s.time >= '17:00');
  if (!dentistId) slots = S.onePerTime(slots);
  res.json({ count: slots.length, date, slots });
}));

// 8. Earliest open slots
app.get('/api/clinics/:id/next', wrap(async (req, res) => {
  const clinic = await getClinic(req.params.id);
  const service = checkService(req.query.service, false);
  const dentistId = req.query.dentist || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const dentists = await getDentists(clinic.id, { service, dentistId });
  const booked = await bookedSet(dentists.map((d) => d.id));
  let slots = S.openSlots({ dentists, booked, now: t.nowSG() });
  if (!dentistId) slots = S.onePerTime(slots);
  slots = slots.slice(0, limit);
  res.json({ count: slots.length, slots });
}));

// Shared check for a slot being booked or moved to.
async function claimableSlot({ clinicId, slotIdValue, service, ignoreRef }) {
  const p = S.parseSlotId(slotIdValue);
  if (!p) fail(400, 'invalid_slot', 'slotId is not valid; take it from the slots list');
  const { rows } = await pool.query('select * from dentists where lower(id) = lower($1) and active', [p.dentistId]);
  const dentist = rows[0];
  const taken = () => fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
  if (!dentist || dentist.clinic_id !== clinicId || !dentist.services.includes(service)) taken();
  const { rows: clash } = await pool.query(
    `select ref from bookings where dentist_id = $1 and slot_date = $2 and slot_time = $3
       and status = any($4) and ($5::text is null or ref <> $5)`,
    [dentist.id, p.date, p.time, ACTIVE, ignoreRef || null],
  );
  const booked = new Set(clash.length ? [`${dentist.id}|${p.date}|${p.time}`] : []);
  if (!S.isBookable({ dentist, date: p.date, time: p.time, booked, now: t.nowSG() })) taken();
  return { dentist, date: p.date, time: p.time };
}

// 9. Create a booking request
app.post('/api/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const clinic = await getClinic(String(b.clinicId || '').trim());
  const service = checkService(b.service, true);
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 66) fail(400, 'invalid_name', 'Please give your full name (2 to 66 characters).');
  const mobile = normMobile(b.mobile);
  if (!mobile) fail(400, 'invalid_mobile', 'Please give a valid Singapore mobile number, for example 9123 4567.');
  const email = b.email ? String(b.email).trim() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'That email address does not look right. Please check it.');
  const slot = await claimableSlot({ clinicId: clinic.id, slotIdValue: b.slotId, service });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `insert into bookings (ref, clinic_id, dentist_id, service, slot_date, slot_time,
           patient_name, patient_mobile, patient_email, notes, channel, conversation_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [newRef(), clinic.id, slot.dentist.id, service, slot.date, slot.time, name, mobile, email,
          b.notes ? String(b.notes).slice(0, 500) : null,
          b.channel ? String(b.channel).slice(0, 50) : null,
          b.conversationId ? String(b.conversationId).slice(0, 100) : null],
      );
      return res.status(201).json(bookingOut(rows[0], clinic, slot.dentist));
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'bookings_one_active_per_slot') {
        fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
      }
      if (e.code !== '23505') throw e; // ref collision: try a new ref
    }
  }
  return fail(500, 'server_error', 'Could not create the booking. Please try again.');
}));

// 10. A patient's bookings
app.get('/api/bookings', wrap(async (req, res) => {
  const mobile = normMobile(req.query.mobile);
  if (!mobile) fail(400, 'invalid_mobile', 'Please give a valid Singapore mobile number, for example 9123 4567.');
  const all = String(req.query.all || '').toLowerCase() === 'true';
  const { rows } = await pool.query(
    'select * from bookings where patient_mobile = $1 order by slot_date, slot_time', [mobile],
  );
  const now = t.nowSG();
  const list = all ? rows : rows.filter((b) => ACTIVE.includes(b.status) && S.isFuture(b.slot_date, b.slot_time, { ...now, minutes: now.minutes - 60 }));
  const bookings = await Promise.all(list.map(expandBooking));
  res.json({ count: bookings.length, bookings });
}));

// 11. One booking
app.get('/api/bookings/:ref', wrap(async (req, res) => {
  const b = await loadBooking(req.params.ref, req.query.mobile);
  res.json(await expandBooking(b));
}));

// 12. Reschedule
app.post('/api/bookings/:ref/reschedule', wrap(async (req, res) => {
  const body = req.body || {};
  const b = await loadBooking(req.params.ref, body.mobile);
  if (!isChangeable(b)) notChangeable(b);
  const slot = await claimableSlot({ clinicId: b.clinic_id, slotIdValue: body.slotId, service: b.service, ignoreRef: b.ref });
  try {
    const { rows } = await pool.query(
      `update bookings set dentist_id = $2, slot_date = $3, slot_time = $4, status = 'requested',
         reschedule_count = reschedule_count + 1, updated_at = now() where ref = $1 returning *`,
      [b.ref, slot.dentist.id, slot.date, slot.time],
    );
    res.json(await expandBooking(rows[0]));
  } catch (e) {
    if (e.code === '23505') fail(409, 'slot_unavailable', 'Sorry, that slot has just been taken. Please choose another time.');
    throw e;
  }
}));

// 13. Cancel
app.post('/api/bookings/:ref/cancel', wrap(async (req, res) => {
  const body = req.body || {};
  const b = await loadBooking(req.params.ref, body.mobile);
  if (!isChangeable(b)) notChangeable(b);
  const { rows } = await pool.query(
    `update bookings set status = 'cancelled', cancel_reason = $2, updated_at = now()
      where ref = $1 returning *`,
    [b.ref, body.reason ? String(body.reason).slice(0, 300) : null],
  );
  res.json(await expandBooking(rows[0]));
}));

// ---------- staff page ----------
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Set ADMIN_PASSWORD to use the staff page.');
  const h = req.get('Authorization') || '';
  const pass = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="ZenAura staff"');
  return res.status(401).send('Login required');
}

app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

app.get('/admin/api/bookings', adminAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('select * from bookings order by created_at desc limit 200');
  const out = await Promise.all(rows.map(expandBooking));
  res.json({ count: out.length, bookings: out });
}));

app.post('/admin/api/bookings/:ref/:action', adminAuth, wrap(async (req, res) => {
  const status = { confirm: 'confirmed', reject: 'rejected', cancel: 'cancelled' }[req.params.action];
  if (!status) fail(404, 'not_found', 'Unknown action');
  const { rows } = await pool.query(
    'update bookings set status = $2, updated_at = now() where upper(ref) = upper($1) returning *',
    [req.params.ref, status],
  );
  if (!rows[0]) fail(404, 'booking_not_found', 'No booking with that reference.');
  res.json(await expandBooking(rows[0]));
}));

app.post('/admin/api/reset', adminAuth, wrap(async (req, res) => {
  const r = await pool.query('delete from bookings');
  res.json({ ok: true, deleted: r.rowCount });
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
