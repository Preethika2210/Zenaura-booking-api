-- =====================================================================
-- ZenAura Dental booking API (demo) - database schema and seed data
-- Run once in Supabase > SQL Editor > New query > Run.
-- Safe to re-run: it drops and recreates every table (all data is reset).
-- Clinic, dentist and patient names are FICTIONAL demo data.
-- =====================================================================

drop table if exists events cascade;
drop table if exists waitlist cascade;
drop table if exists bookings cascade;
drop table if exists patients cascade;
drop table if exists dentists cascade;
drop table if exists services cascade;
drop table if exists clinics cascade;

-- ---------- Services (staff can add more from the staff console) -----
create table services (
  id        text primary key,          -- e.g. cleaning
  name      text not null,
  sort      int  not null default 100,
  active    boolean not null default true
);

-- ---------- Clinics --------------------------------------------------
create table clinics (
  id        text primary key,          -- e.g. tampines-601b
  name      text not null,
  area      text not null,
  region    text not null check (region in ('Central','East','North','North-East','West')),
  address   text not null,
  phone     text,
  hours     jsonb not null,            -- {"Mon": "9:00 AM - 6:00 PM", ...}
  maps_url  text,
  active    boolean not null default true
);

-- ---------- Dentists and therapists ----------------------------------
-- services: which services this person offers (ids from the services table)
-- schedule: ISO weekday (1 = Mon ... 7 = Sun) -> list of [start, end] blocks, 24h
create table dentists (
  id         text primary key,         -- short opaque id, e.g. tp6a
  clinic_id  text not null references clinics(id),
  name       text not null,
  note       text,                     -- e.g. "Simple cleaning only"
  services   text[] not null,
  schedule   jsonb not null,
  active     boolean not null default true
);

-- ---------- Patients and membership tiers -----------------------------
-- tier: standard | silver | gold | platinum. Higher tiers get member priority
-- slots, a better place on the waitlist and a higher ticket priority in Zendesk.
create table patients (
  mobile          text primary key,    -- +65XXXXXXXX
  name            text not null,
  email           text,
  tier            text not null default 'standard'
                  check (tier in ('standard','silver','gold','platinum')),
  preferred_clinic text references clinics(id),
  notes           text,
  member_since    date not null default current_date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- Bookings (requests) --------------------------------------
create table bookings (
  ref              text primary key,   -- ZD-XXXX
  status           text not null default 'requested'
                   check (status in ('requested','confirmed','rejected','cancelled')),
  clinic_id        text not null references clinics(id),
  dentist_id       text not null references dentists(id),
  service          text not null references services(id),
  slot_date        date not null,      -- Singapore date
  slot_time        text not null,      -- HH:MM, Singapore time
  patient_name     text not null,
  patient_mobile   text not null,      -- +65XXXXXXXX
  patient_email    text,
  tier             text not null default 'standard',  -- patient's tier when booked
  source           text not null default 'chat',      -- chat | staff | waitlist
  notes            text,
  channel          text,
  conversation_id  text,
  reschedule_count int  not null default 0,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One active booking per dentist per slot: a second request for the same slot fails.
create unique index bookings_one_active_per_slot
  on bookings (dentist_id, slot_date, slot_time)
  where status in ('requested','confirmed');

create index bookings_mobile_idx on bookings (patient_mobile);

-- ---------- Waitlist -------------------------------------------------
-- When a booked slot is freed, it is offered to the highest-priority waiting
-- patient for that clinic and service, and held for them for 2 hours.
create table waitlist (
  ref                text primary key, -- WL-XXXX
  status             text not null default 'waiting'
                     check (status in ('waiting','offered','booked','removed')),
  clinic_id          text not null references clinics(id),
  service            text not null references services(id),
  dentist_id         text references dentists(id),   -- null = any dentist
  from_date          date,                           -- null = any date
  patient_name       text not null,
  patient_mobile     text not null,
  tier               text not null default 'standard',
  priority           int  not null default 0,        -- 0 standard ... 3 platinum
  offered_dentist_id text references dentists(id),
  offered_date       date,
  offered_time       text,
  offer_expires      timestamptz,
  booking_ref        text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index waitlist_queue_idx on waitlist (clinic_id, service, status, priority desc, created_at);

-- ---------- Activity log (shown on the staff console) -----------------
create table events (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  kind    text not null,
  ref     text,
  actor   text not null,                 -- patient | staff | system
  detail  text not null
);

-- Close the tables to Supabase's public Data API. The API server connects
-- with the database password and is not affected.
alter table services enable row level security;
alter table clinics  enable row level security;
alter table dentists enable row level security;
alter table patients enable row level security;
alter table bookings enable row level security;
alter table waitlist enable row level security;
alter table events   enable row level security;

-- ---------- Seed: services -------------------------------------------
insert into services (id, name, sort) values
('consult',  'General consultation', 10),
('cleaning', 'Scaling & polishing (cleaning)', 20),
('filling',  'Simple filling', 30);

-- ---------- Seed: clinics --------------------------------------------
insert into clinics (id, name, area, region, address, phone, hours, maps_url) values
('tampines-601b', 'ZenAura Dental Centre – Tampines HDB Block 601B', 'Tampines HDB Block 601B', 'East',
 'Blk 601B #01-07, Tampines Ave 9, Singapore', '60000001',
 '{"Mon":"9:00 AM – 6:00 PM","Tue":"9:00 AM – 6:00 PM","Wed":"9:00 AM – 6:00 PM","Thu":"9:00 AM – 6:00 PM","Fri":"9:00 AM – 6:00 PM","Sat":"9:00 AM – 6:00 PM","Sun":"9:00 AM – 1:00 PM","PH":"Closed"}',
 'https://www.google.com/maps/search/?api=1&query=ZenAura+Dental+Tampines+601B'),
('tampines-1', 'ZenAura Dental Centre – Tampines 1', 'Tampines 1', 'East',
 '10 Tampines Central 1, #05-12/13, Tampines 1, Singapore', '60000002',
 '{"Mon":"9:00 AM – 6:00 PM","Tue":"9:00 AM – 6:00 PM","Wed":"9:00 AM – 6:00 PM","Thu":"9:00 AM – 6:00 PM","Fri":"9:00 AM – 6:00 PM","Sat":"9:00 AM – 6:00 PM","Sun":"Closed","PH":"Closed"}',
 'https://www.google.com/maps/search/?api=1&query=ZenAura+Dental+Tampines+1'),
('bishan-501', 'ZenAura Dental Centre – Bishan Block 501', 'Bishan Block 501', 'Central',
 'Blk 501, Bishan Street 11, #01-372, Singapore 570501', '60000003',
 '{"Mon":"9:00 AM – 6:00 PM","Tue":"9:00 AM – 6:00 PM","Wed":"9:00 AM – 6:00 PM","Thu":"9:00 AM – 6:00 PM","Fri":"9:00 AM – 6:00 PM","Sat":"9:00 AM – 6:00 PM","Sun":"9:00 AM – 1:00 PM","PH":"Closed"}',
 'https://www.google.com/maps/search/?api=1&query=ZenAura+Dental+Bishan+501');

-- ---------- Seed: dentists (fictional names) -------------------------
insert into dentists (id, clinic_id, name, note, services, schedule) values
('tp6a', 'tampines-601b', 'Dr Aaron Lim', null, '{consult,filling}',
 '{"1":[["09:00","13:00"],["14:00","18:00"]],"2":[["09:00","13:00"],["14:00","18:00"]],"3":[["09:00","13:00"]],"4":[["09:00","13:00"],["14:00","18:00"]],"5":[["09:00","13:00"],["14:00","18:00"]],"6":[["09:00","13:00"]]}'),
('tp6b', 'tampines-601b', 'Dr Mei Tan', null, '{consult,filling,cleaning}',
 '{"2":[["14:00","18:00"]],"3":[["09:00","13:00"],["14:00","18:00"]],"5":[["14:00","18:00"]],"6":[["09:00","13:00"],["14:00","18:00"]],"7":[["09:00","13:00"]]}'),
('tp6c', 'tampines-601b', 'Sarah Ng (Oral Health Therapist)', 'Simple cleaning only', '{cleaning}',
 '{"1":[["09:00","13:00"],["14:00","18:00"]],"3":[["14:00","18:00"]],"4":[["09:00","13:00"]],"6":[["09:00","13:00"]]}'),
('tc1a', 'tampines-1', 'Dr Rachel Goh', null, '{consult,filling,cleaning}',
 '{"1":[["09:00","13:00"],["14:00","18:00"]],"2":[["09:00","13:00"],["14:00","18:00"]],"3":[["09:00","13:00"],["14:00","18:00"]],"4":[["14:00","18:00"]],"5":[["09:00","13:00"]],"6":[["09:00","13:00"]]}'),
('tc1b', 'tampines-1', 'Dr Daniel Koh', null, '{consult,filling}',
 '{"2":[["14:00","18:00"]],"4":[["09:00","13:00"],["14:00","18:00"]],"5":[["09:00","13:00"],["14:00","18:00"]],"6":[["14:00","18:00"]]}'),
('bs5a', 'bishan-501', 'Dr Wei Ming Chua', null, '{consult,filling}',
 '{"1":[["09:00","13:00"],["14:00","18:00"]],"2":[["09:00","13:00"]],"3":[["09:00","13:00"],["14:00","18:00"]],"5":[["09:00","13:00"],["14:00","18:00"]],"6":[["09:00","13:00"]],"7":[["09:00","13:00"]]}'),
('bs5b', 'bishan-501', 'Dr Priya Nair', null, '{consult,filling,cleaning}',
 '{"2":[["14:00","18:00"]],"3":[["14:00","18:00"]],"4":[["09:00","13:00"],["14:00","18:00"]],"6":[["14:00","18:00"]]}'),
('bs5c', 'bishan-501', 'Nur Aisyah (Oral Health Therapist)', 'Simple cleaning only', '{cleaning}',
 '{"1":[["14:00","18:00"]],"2":[["09:00","13:00"]],"4":[["09:00","13:00"]],"5":[["14:00","18:00"]],"6":[["09:00","13:00"]]}');


-- ---------- Seed: patients and members (fictional) -------------------
insert into patients (mobile, name, email, tier, preferred_clinic, notes, member_since) values
('+6590000001', 'Tan Siew Ling', 'siewling.demo@example.com', 'platinum', 'tampines-601b', 'Prefers Dr Mei Tan', '2021-03-15'),
('+6590000002', 'Rajesh Kumar',  'rajesh.demo@example.com',   'gold',     'bishan-501',    null, '2023-07-01'),
('+6590000003', 'Chloe Wong',    'chloe.demo@example.com',    'silver',   'tampines-1',    null, '2024-11-20'),
('+6590000004', 'Ahmad Faiz',    null,                        'standard', 'bishan-501',    null, '2026-01-10');

select 'Schema ready: ' || (select count(*) from clinics) || ' clinics, ' ||
       (select count(*) from dentists) || ' dentists, ' ||
       (select count(*) from services) || ' services, ' ||
       (select count(*) from patients) || ' patients' as result;
