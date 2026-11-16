-- =====================================================================
-- ZenAura Dental booking API (demo) - database schema and seed data
-- Run once in Supabase > SQL Editor > New query > Run.
-- Safe to re-run: it drops and recreates the three tables.
-- Clinics are ZenAura Dental clinics; dentist names are FICTIONAL demo data.
-- =====================================================================

drop table if exists bookings cascade;
drop table if exists dentists cascade;
drop table if exists clinics cascade;

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
-- services: which bookable services this person offers (consult, cleaning, filling)
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

-- ---------- Bookings (requests) --------------------------------------
create table bookings (
  ref              text primary key,   -- ZD-XXXX
  status           text not null default 'requested'
                   check (status in ('requested','confirmed','rejected','cancelled')),
  clinic_id        text not null references clinics(id),
  dentist_id       text not null references dentists(id),
  service          text not null check (service in ('consult','cleaning','filling')),
  slot_date        date not null,      -- Singapore date
  slot_time        text not null,      -- HH:MM, Singapore time
  patient_name     text not null,
  patient_mobile   text not null,      -- +65XXXXXXXX
  patient_email    text,
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

-- Close the tables to Supabase's public Data API. The API server connects
-- with the database password and is not affected.
alter table clinics  enable row level security;
alter table dentists enable row level security;
alter table bookings enable row level security;

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

select 'Schema ready: ' || (select count(*) from clinics) || ' clinics, ' ||
       (select count(*) from dentists) || ' dentists' as result;
