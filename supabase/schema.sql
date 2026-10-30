-- By the Beach Golf Cart Rentals: database setup
-- Paste all of this into Supabase > SQL Editor and press Run.

create table if not exists fleet (
  type text primary key,              -- '4' or '6'
  name text not null,
  count int not null,                 -- how many carts of this type
  week_price int not null,            -- summer weekly price, dollars
  day_price int not null              -- off-season daily price, dollars
);

insert into fleet (type, name, count, week_price, day_price) values
  ('4', '4-Seater Bintelli', 4, 600, 95),
  ('6', '6-Seater Bintelli', 3, 700, 115)
on conflict (type) do nothing;

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_at timestamptz not null default now(),
  cart_type text not null references fleet(type),
  start_date date not null,
  end_date date not null,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  name text not null,
  phone text not null,
  email text not null,
  stay text,
  party text,
  notes text,
  total int not null,
  deposit int not null,
  signature text,
  agreed_at timestamptz,
  source text not null default 'web',  -- 'web' or 'phone'
  check (end_date > start_date)
);
create index if not exists bookings_dates on bookings (cart_type, start_date, end_date);

-- carts taken out of service (repairs) or held back
create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  cart_type text not null references fleet(type),
  start_date date not null,
  end_date date not null,
  qty int not null default 1,
  reason text,
  check (end_date > start_date)
);

-- Lock everything down: only the website's server (service key) can read or write.
alter table fleet enable row level security;
alter table bookings enable row level security;
alter table blocks enable row level security;
