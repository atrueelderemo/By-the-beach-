// By the Beach Golf Cart Rentals — API worker
// Static site files are served by Cloudflare assets; anything under /api/ comes here.
// Secrets (set in Cloudflare > Worker > Settings > Variables and Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (required for bookings)
//   RESEND_API_KEY, OWNER_EMAIL, FROM_EMAIL  (optional, for email notifications)

const DAY = 86400000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return Response.redirect(url.origin + '/admin.html', 302);
    }
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (url.pathname === '/api/availability' && request.method === 'GET') return await availability(env);
      if (url.pathname === '/api/book' && request.method === 'POST') return await book(request, env);
      if (url.pathname === '/api/admin/login' && request.method === 'POST') return await adminLogin(request, env);
      if (url.pathname.startsWith('/api/admin/')) {
        if (!(await checkToken(request, env))) return json({ error: 'Please sign in again.' }, 401);
        return await admin(url, request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e && e.message || e) }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function db(env, path, init = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error('Database not configured');
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      // legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey
      ...(env.SUPABASE_SERVICE_KEY.startsWith('eyJ') ? { authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY } : {}),
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

const iso = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d) ? null : d;
};

// Busy intervals for the next ~18 months: bookings (not cancelled) + blocks. No customer details leave the server.
async function loadBusy(env) {
  const today = iso(new Date(Date.now() - DAY));
  const [fleet, bookings, blocks] = await Promise.all([
    db(env, 'fleet?select=type,name,count,week_price,day_price&order=type'),
    db(env, `bookings?select=cart_type,start_date,end_date&status=neq.cancelled&end_date=gte.${today}`),
    db(env, `blocks?select=cart_type,start_date,end_date,qty&end_date=gte.${today}`),
  ]);
  const busy = [];
  for (const b of bookings) busy.push({ t: b.cart_type, s: b.start_date, e: b.end_date, q: 1 });
  for (const b of blocks) busy.push({ t: b.cart_type, s: b.start_date, e: b.end_date, q: b.qty || 1 });
  return { fleet, busy };
}

async function availability(env) {
  const { fleet, busy } = await loadBusy(env);
  return json({ fleet, busy });
}

// Max carts of a type in use on any day in [start, end)
function maxInUse(busy, type, start, end) {
  let max = 0;
  for (let d = start.getTime(); d < end.getTime(); d += DAY) {
    const day = iso(new Date(d));
    let n = 0;
    for (const b of busy) if (b.t === type && b.s <= day && b.e > day) n += b.q;
    if (n > max) max = n;
  }
  return max;
}

const isPeak = (d) => { const m = d.getUTCMonth(); return m >= 5 && m <= 7; };

function priceFor(f, start, end) {
  const n = Math.round((end - start) / DAY);
  if (isPeak(start)) return f.week_price * Math.round(n / 7);
  const wk = Math.floor(n / 7), rem = n % 7;
  return wk * f.week_price + Math.min(rem * f.day_price, f.week_price);
}

async function book(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const start = parseDate(b.start), end = parseDate(b.end);
  const s = (v, max = 200) => String(v || '').trim().slice(0, max);
  const name = s(b.name), phone = s(b.phone, 40), email = s(b.email, 200);
  if (!start || !end || end <= start) return json({ error: 'Please pick valid dates.' }, 400);
  if (start < new Date(Date.now() - DAY)) return json({ error: 'That date has passed.' }, 400);
  if (isPeak(start) && (start.getUTCDay() !== 6 || Math.round((end - start) / DAY) % 7 !== 0))
    return json({ error: 'Summer rentals run Saturday to Saturday.' }, 400);
  if (!name || phone.replace(/\D/g, '').length < 10 || !/^\S+@\S+\.\S+$/.test(email))
    return json({ error: 'Please fill in your name, phone and email.' }, 400);

  const { fleet, busy } = await loadBusy(env);
  const f = fleet.find((x) => x.type === String(b.cart));
  if (!f) return json({ error: 'Please choose a cart.' }, 400);
  if (f.count - maxInUse(busy, f.type, start, end) <= 0)
    return json({ error: 'Sorry, that cart just sold out for those dates. Please pick another cart or week.' }, 409);

  const total = priceFor(f, start, end);
  const deposit = Math.min(150, total);
  const code = 'BTB-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const [row] = await db(env, 'bookings', {
    method: 'POST',
    body: JSON.stringify({
      code, cart_type: f.type, start_date: iso(start), end_date: iso(end),
      name, phone, email, stay: s(b.stay), party: s(b.party, 10), notes: s(b.notes, 1000),
      total, deposit, signature: typeof b.signature === 'string' ? b.signature.slice(0, 200000) : null,
      agreed_at: new Date().toISOString(), status: 'pending', source: 'web',
    }),
  });

  await notify(env, { ...row, cart_name: f.name }).catch(() => {});
  return json({ ok: true, code: row.code, total, deposit, balance: total - deposit });
}

const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL || 'By the Beach <onboarding@resend.dev>', to, subject, html }),
  });
}

async function notify(env, r) {
  const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [
    ['Booking', r.code], ['Cart', r.cart_name], ['Pickup', fmt(r.start_date)], ['Return', fmt(r.end_date)],
    ['Name', r.name], ['Phone', r.phone], ['Email', r.email], ['Staying at', r.stay], ['Party size', r.party],
    ['Notes', r.notes], ['Total', '$' + r.total], ['Due today', '$' + r.deposit], ['Due at pickup', '$' + (r.total - r.deposit)],
  ].filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5b707b">${k}</td><td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`).join('');
  const table = `<table style="font-family:Arial,sans-serif;font-size:15px;border-collapse:collapse">${rows}</table>`;
  await sendEmail(env, env.OWNER_EMAIL,
    `New booking ${r.code}: ${r.cart_name}, ${fmt(r.start_date)}`,
    `<div style="font-family:Arial,sans-serif"><h2 style="color:#0e3a54">New booking request</h2>${table}</div>`);
  await sendEmail(env, r.email,
    `Your By the Beach golf cart booking (${r.code})`,
    `<div style="font-family:Arial,sans-serif"><h2 style="color:#0e3a54">Thanks, ${esc(r.name.split(' ')[0])}! We've got your booking.</h2>
     <p>We'll text you pickup details before your trip. Pickup is at 6016 E Oak Island Dr, Unit B, Oak Island, NC.</p>${table}
     <p>Questions? Call or text (704) 779-0263.</p></div>`);
}


/* ================= ADMIN ================= */
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'Admin password not set up yet.' }, 503);
  const b = await request.json().catch(() => ({}));
  const pw = String(b.password || '');
  // compare hashes so length doesn't leak
  if (!safeEq(await hmac('pw', pw), await hmac('pw', env.ADMIN_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: 'Wrong password.' }, 401);
  }
  const exp = String(Date.now() + 14 * DAY);
  return json({ token: exp + '.' + (await hmac(env.ADMIN_PASSWORD, exp)) });
}
async function checkToken(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const tok = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, await hmac(env.ADMIN_PASSWORD, exp));
}
const COLS = 'id,code,created_at,cart_type,start_date,end_date,status,name,phone,email,stay,party,notes,total,deposit,source';
async function admin(url, request, env) {
  const p = url.pathname.replace('/api/admin/', '');
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const s = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const uuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null;

  if (p === 'data') {
    const since = iso(new Date(Date.now() - 60 * DAY));
    const [fleet, bookings, blocks] = await Promise.all([
      db(env, 'fleet?select=*&order=type'),
      db(env, `bookings?select=${COLS}&end_date=gte.${since}&order=start_date.asc`),
      db(env, `blocks?select=*&end_date=gte.${iso(new Date(Date.now() - DAY))}&order=start_date.asc`),
    ]);
    return json({ fleet, bookings, blocks });
  }
  if (p === 'signature') {
    const id = uuid(url.searchParams.get('id'));
    if (!id) return json({ error: 'Bad id' }, 400);
    const [r] = await db(env, `bookings?select=signature,agreed_at&id=eq.${id}`);
    return json(r || {});
  }
  if (p === 'status') {
    const id = uuid(body.id), st = body.status;
    if (!id || !['pending', 'confirmed', 'cancelled'].includes(st)) return json({ error: 'Bad request' }, 400);
    await db(env, `bookings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: st }) });
    return json({ ok: true });
  }
  if (p === 'booking') {
    const start = parseDate(body.start), end = parseDate(body.end);
    if (!start || !end || end <= start) return json({ error: 'Pick valid dates.' }, 400);
    const { fleet, busy } = await loadBusy(env);
    const f = fleet.find((x) => x.type === String(body.cart));
    if (!f) return json({ error: 'Pick a cart.' }, 400);
    if (!s(body.name)) return json({ error: 'Enter a name.' }, 400);
    if (f.count - maxInUse(busy, f.type, start, end) <= 0 && !body.force)
      return json({ error: 'No ' + f.name + ' free for those dates.', full: true }, 409);
    const total = body.total !== '' && body.total != null && !isNaN(Number(body.total)) ? Math.round(Number(body.total)) : priceFor(f, start, end);
    const code = 'BTB-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const [row] = await db(env, 'bookings', { method: 'POST', body: JSON.stringify({
      code, cart_type: f.type, start_date: iso(start), end_date: iso(end), name: s(body.name), phone: s(body.phone, 40),
      email: s(body.email), stay: s(body.stay), notes: s(body.notes, 1000), total, deposit: 0, status: 'confirmed', source: 'phone',
    }) });
    return json({ ok: true, code: row.code });
  }
  if (p === 'block') {
    const start = parseDate(body.start), end = parseDate(body.end);
    if (!start || !end || end <= start) return json({ error: 'Pick valid dates.' }, 400);
    if (!['4', '6'].includes(String(body.cart))) return json({ error: 'Pick a cart.' }, 400);
    await db(env, 'blocks', { method: 'POST', body: JSON.stringify({
      cart_type: String(body.cart), start_date: iso(start), end_date: iso(end), qty: Math.max(1, Math.min(50, parseInt(body.qty) || 1)), reason: s(body.reason),
    }) });
    return json({ ok: true });
  }
  if (p === 'unblock') {
    const id = uuid(body.id);
    if (!id) return json({ error: 'Bad id' }, 400);
    await db(env, `blocks?id=eq.${id}`, { method: 'DELETE' });
    return json({ ok: true });
  }
  if (p === 'fleet') {
    const type = String(body.type);
    if (!['4', '6'].includes(type)) return json({ error: 'Bad cart' }, 400);
    const n = (v) => Math.max(0, Math.min(100000, parseInt(v) || 0));
    await db(env, `fleet?type=eq.${type}`, { method: 'PATCH', body: JSON.stringify({ count: n(body.count), week_price: n(body.week_price), day_price: n(body.day_price) }) });
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}
