/**
 * POST /api/submit — the only way rows reach Supabase.
 *
 * The forms used to insert straight from the browser with the anon key, which
 * made the REST endpoint a public write target: ~1 spam row every couple of
 * days, plus replayed duplicates. Everything now goes through here so the
 * service-role key stays server-side and submissions have to clear a few
 * cheap bot filters first.
 *
 * Required env vars (Vercel → Settings → Environment Variables):
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role key — server-only, never ship to the client
 *
 * Optional:
 *   TURNSTILE_SECRET_KEY  when set, a valid Cloudflare Turnstile token is required
 *   ALLOWED_ORIGINS       comma-separated hosts; defaults to same-origin only
 */

const MIN_FILL_MS = 3000;         // humans take longer than this to fill a form
const MAX_FORM_AGE_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;        // submissions per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PURPOSES = ['General enquiry', 'Partnership', 'Press', 'Careers'];

// Per-instance only — a warm lambda catches bursts, a cold one starts fresh.
// This is a speed bump, not the security boundary; that's the revoked anon
// INSERT policy plus the service-role key never leaving the server.
const hits = new Map();

/**
 * Returns '' when the client can't be identified. Callers must then SKIP the
 * rate limit rather than bucket everyone together — an earlier version fell
 * back to a literal 'unknown' key, which put every unidentified visitor in one
 * shared bucket and started returning 429 to legitimate users.
 */
function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => String(v || '').split(',')[0].trim();
  return first(h['x-forwarded-for']) || first(h['x-real-ip']) || first(h['x-vercel-forwarded-for']) || '';
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT_MAX;
}

/**
 * Drive-by bots either omit Origin or send someone else's. A determined
 * attacker can forge the header, so this filters noise rather than securing
 * the endpoint.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;

  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  if (allowList.length) return allowList.includes(host);
  return host === String(req.headers.host || '').toLowerCase();
}

async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured yet — skip the check

  const body = new URLSearchParams({ secret, response: token || '' });
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}

async function insert(table, row) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (res.ok) return;

  const detail = await res.text();
  // 23505 = unique violation. On signups that means "already on the list",
  // which the old client treated as success — keep that behaviour.
  if (table === 'signups' && detail.includes('23505')) return;
  throw new Error(`supabase ${res.status}: ${detail}`);
}

const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The field is optional, so blank is fine — but it should look like a phone
 * number when present. One row arrived with mobile="subseco", which is how a
 * free-text column tells you the browser was never involved.
 */
function phone(v) {
  const raw = str(v, 24);
  if (!raw) return '';
  if (!/^[+\d(][\d\s()\-.]*$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? raw : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  if (!originAllowed(req)) return res.status(403).json({ error: 'Forbidden' });

  // No identifiable IP → no rate limiting. The honeypot, timing and origin
  // checks are what actually filter bots; a shared bucket would only deny
  // service to real people.
  const ip = clientIp(req);
  if (ip && rateLimited(ip)) return res.status(429).json({ error: 'Too many submissions' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: 'Bad request' });

  // Honeypot: hidden field, invisible to humans, irresistible to form fillers.
  if (str(body.website, 200)) return res.status(200).json({ ok: true });

  // Timing: `t` is stamped when the page loads. Instant posts are scripted;
  // stale ones are replayed captures.
  const elapsed = Date.now() - Number(body.t || 0);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS || elapsed > MAX_FORM_AGE_MS) {
    return res.status(400).json({ error: 'Please try again' });
  }

  if (!(await turnstileOk(body.token, ip))) {
    return res.status(403).json({ error: 'Verification failed' });
  }

  const email = str(body.email, 200).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  try {
    if (body.form === 'signup') {
      await insert('signups', { email });
    } else if (body.form === 'contact') {
      const name = str(body.name, 100);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const mobile = phone(body.mobile);
      if (mobile === null) return res.status(400).json({ error: 'Invalid mobile number' });

      // The old client wrote whatever arrived; rows like purpose="test" are how
      // we know inserts bypassed the browser. Anything off the dropdown now
      // falls back rather than being stored as-is.
      const purpose = str(body.purpose, 50);
      await insert('contacts', {
        name,
        email,
        mobile,
        purpose: PURPOSES.includes(purpose) ? purpose : 'General enquiry',
        message: str(body.message, 200),
      });
    } else {
      return res.status(400).json({ error: 'Unknown form' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }

  return res.status(200).json({ ok: true });
};

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
