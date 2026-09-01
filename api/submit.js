/**
 * POST /api/submit — the only way rows reach Supabase.
 *
 * The forms used to insert straight from the browser with the anon key, which
 * made the REST endpoint a public write target: ~1 spam row every couple of
 * days, plus replayed duplicates. Everything now goes through here so the
 * service-role key stays server-side and submissions have to clear a few
 * cheap bot filters first.
 *
 * A successful insert now also sends a notification email through Resend. Read
 * the notify() comment before touching any of it: the row is the record of
 * truth and the email is a courtesy on top, so nothing on the mail path is
 * allowed to fail a submission, delay it unboundedly, or turn a saved row into
 * an error for the visitor.
 *
 * Required env vars (Vercel → Settings → Environment Variables):
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role key — server-only, never ship to the client
 *
 * Optional:
 *   TURNSTILE_SECRET_KEY  when set, a valid Cloudflare Turnstile token is required
 *   ALLOWED_ORIGINS       comma-separated hosts; defaults to same-origin only
 *   RESEND_API_KEY        Resend → API Keys, "Sending access" is enough. Unset,
 *                         notifications are skipped and submissions still save.
 *   NOTIFY_FROM           sender, e.g. "Peshagi <notifications@send.peshagi.com>".
 *                         Must be on a domain verified in Resend. NEVER the
 *                         visitor's address — see the note above notify().
 *   NOTIFY_TO             comma-separated recipients. While NOTIFY_FROM is still
 *                         Resend's shared onboarding@resend.dev sender this MUST
 *                         be the Resend account owner's own address; that sender
 *                         is refused (403) for anyone else.
 */

const MIN_FILL_MS = 3000;         // humans take longer than this to fill a form
const MAX_FORM_AGE_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;        // submissions per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PURPOSES = ['General enquiry', 'Partnership', 'Press', 'Careers'];

// Hard ceilings on every outbound call this handler makes. fetch() has no
// useful default timeout — a server that accepts the TCP connection and then
// never sends headers leaves an unbounded fetch pending forever — and Vercel's
// default maxDuration is now 300s on both Hobby and Pro. Unbounded, one hung
// upstream therefore burns five minutes of billed memory and hands the visitor
// a 504 for a submission that may already be saved. These three numbers plus
// the maxDuration in vercel.json are what make that impossible.
const TURNSTILE_TIMEOUT_MS = 5000;
const SUPABASE_TIMEOUT_MS = 8000;
const NOTIFY_TIMEOUT_MS = 3500;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

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
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}

/**
 * PostgREST forwards PostgreSQL's error structure verbatim as JSON and puts the
 * SQLSTATE in a dedicated field:
 *
 *   {"code":"23505",
 *    "details":"Key (email)=(a@b.com) already exists.",
 *    "hint":null,
 *    "message":"duplicate key value violates unique constraint \"signups_email_key\""}
 *
 * Read the code from there rather than grepping the raw body. A failure that
 * never reached PostgREST at all (a gateway 502, an HTML error page) is not
 * JSON, so a parse failure has to read as "no code" instead of throwing over
 * the top of the real error we are trying to report.
 */
function errorCode(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed.code === 'string' ? parsed.code : '';
  } catch {
    return '';
  }
}

/**
 * Inserts one row and reports whether a row was ACTUALLY created.
 *
 *   true  — Postgres wrote a new row.
 *   false — the row already existed and we chose to report that as success.
 *
 * The return value is new, and it exists for one reason: to decide whether
 * there is anything to email about. Without it every returning subscriber who
 * re-submits the signup form generates a "new signup!" for a row that was
 * never created. See the duplicate-signup note at the call site.
 *
 * Note that PostgREST does NOT quietly absorb a unique violation — it returns a
 * genuine 409 and this function is what swallows it. So the created/duplicate
 * answer was always sitting right here on the line that discarded it, and
 * `Prefer: return=minimal` needs no change: with no body to parse, "did a row
 * appear?" is exactly "did this not fail?".
 *
 * `ignoreDuplicate` replaces the old hardcoded `table === 'signups'` test, so
 * the "duplicates are expected here" decision now sits at the call site, and
 * this signature matches the sibling handler in pervyuktLanding.
 */
async function insert(table, row, ignoreDuplicate = false) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });

  if (res.ok) return true;

  const detail = await res.text();
  // 23505 = unique violation. On signups that means "already on the list",
  // which the old client treated as success — keep that behaviour, but tell the
  // caller, so it can skip the notification.
  //
  // This used to be `detail.includes('23505')`, which matched those digits
  // anywhere in the raw body and ignored the status entirely. PostgreSQL echoes
  // the offending row back inside `details` ("Failing row contains (...)"), so
  // an unrelated failure on an address like 23505@example.com matched too — and
  // was then discarded as a duplicate: no row, nothing thrown, nothing logged,
  // and under the new feature no email either. Narrow, but it loses real
  // submissions silently, which is the one outcome this endpoint must never
  // produce. Match the status AND the structured code.
  if (ignoreDuplicate && res.status === 409 && errorCode(detail) === '23505') return false;
  throw new Error(`supabase ${res.status}: ${detail}`);
}

/* -------------------------------------------------------------- notification */

/**
 * Escapes the five characters that can break out of HTML text or an attribute
 * value. Every user-supplied byte that reaches the email body goes through
 * this, & first so entities are not double-escaped.
 *
 * This is not paranoia about a form on a coming-soon page. The notification is
 * the one place where the site's operator reads attacker-controlled text with
 * their guard down — in a webmail preview pane, and in the Resend dashboard's
 * own HTML view, which is a browser page they are logged into. Unescaped, a
 * `message` of `<img src=x onerror=...>` is live markup there, not a string.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape FIRST, then turn newlines into <br> — never the other way round. */
function escapeMultiline(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Strips CR/LF/tabs and collapses runs of whitespace, for the subject line.
 *
 * To be clear about why: this is NOT classic SMTP header injection defence.
 * Resend's send endpoint is a JSON REST API — a newline travels as the two
 * characters \n inside a JSON document, Resend parses it server-side and builds
 * the MIME message itself, and `to`/`from` are separate typed fields, so a
 * newline in `subject` cannot terminate a header or fabricate a Bcc: line the
 * way it can with raw SMTP or PHP mail(). This is purely so a subject with
 * newlines in it doesn't render as garbage and hide text from whoever reads it.
 * The real injection surface here is the HTML body, handled above.
 */
function headerSafe(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max || 200);
}

/**
 * An href is an attribute context, so the address is whitelisted before it is
 * ever concatenated into one. This pattern admits no quote, angle bracket,
 * space, colon or backslash — everything you would need to escape the attribute
 * or smuggle in a javascript: scheme. Anything that fails it renders as escaped
 * plain text instead of a link, which is a fine outcome.
 */
const MAILTO_SAFE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const mailtoLink = (email) =>
  MAILTO_SAFE.test(email)
    ? `<a href="mailto:${escapeHtml(email)}" style="color:#0f766e;text-decoration:none">${escapeHtml(email)}</a>`
    : escapeHtml(email);

const WRAP = (title, rows) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:10px">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #f0efee">
      <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#78716c">Peshagi</div>
      <div style="font-size:17px;font-weight:600;margin-top:4px">${title}</div>
    </td></tr>
    <tr><td style="padding:8px 24px 20px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;line-height:1.55">${rows}</table>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #f0efee;font-size:12px;color:#78716c">Reply to this message to answer them directly.</td></tr>
  </table>
</body></html>`;

const ROW = (label, valueHtml) => `<tr>
  <td style="padding:7px 0;width:110px;vertical-align:top;color:#78716c;font-size:12px;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(label)}</td>
  <td style="padding:7px 0;vertical-align:top;word-break:break-word">${valueHtml}</td>
</tr>`;

/**
 * Builds the Resend payload for one submission. Every dynamic value in the html
 * has been through escapeHtml/escapeMultiline/mailtoLink; the text part is the
 * same data with no escaping, which is correct because it is never parsed as
 * markup.
 */
function buildEmail(kind, row) {
  if (kind === 'signup') {
    return {
      subject: headerSafe(`Peshagi signup — ${row.email}`, 200),
      html: WRAP('New waitlist signup', ROW('Email', mailtoLink(row.email))),
      text: `New waitlist signup\n\nEmail: ${row.email}\n`,
    };
  }

  const rows = [
    ROW('Name', escapeHtml(row.name)),
    ROW('Email', mailtoLink(row.email)),
    row.mobile ? ROW('Mobile', escapeHtml(row.mobile)) : '',
    ROW('Purpose', escapeHtml(row.purpose)),
    row.message ? ROW('Message', escapeMultiline(row.message)) : '',
  ].join('');

  return {
    subject: headerSafe(`Peshagi enquiry (${row.purpose}) — ${row.name}`, 200),
    html: WRAP('New contact enquiry', rows),
    text:
      'New contact enquiry\n\n' +
      `Name:    ${row.name}\n` +
      `Email:   ${row.email}\n` +
      `Mobile:  ${row.mobile || '-'}\n` +
      `Purpose: ${row.purpose}\n\n` +
      `${row.message || '(no message)'}\n`,
  };
}

/**
 * Tells us a row landed. NEVER THROWS and never rejects — every exit path
 * returns. That is the contract the handler depends on: by the time this runs
 * the row is already committed in Supabase, so nothing in here is allowed to
 * become the visitor's error.
 *
 * It is awaited rather than fired and forgotten. Vercel's own guidance is
 * explicit that once a function sends its response, background work pauses and
 * only resumes when the function is next invoked — so a dangling promise stops
 * partway through the TLS exchange and the email is silently never sent, or is
 * sent minutes later on some other visitor's request. The supported way to keep
 * work running past the response is `after()` / `waitUntil()`, and neither is
 * reachable here: `after()` is a Next.js export and `waitUntil()` lives in the
 * @vercel/functions npm package, which would mean giving this project its first
 * package.json, its first lockfile, and its first build step — turning Vercel's
 * install/framework detection back on for a static site whose entire job is to
 * load. Not worth it to save a third of a second on a form the visitor has
 * already finished with. So: awaited, and hard-bounded by NOTIFY_TIMEOUT_MS.
 * The sibling Pervyukt handler is a Next.js app and legitimately uses after()
 * there; that divergence is deliberate.
 *
 * @param {'signup'|'contact'} kind
 * @param {object} row     the row that was just written
 * @param {number} loadedAt the page-load stamp, used as the idempotency scope
 */
async function notify(kind, row, loadedAt) {
  const started = Date.now();
  const source = `peshagi:${kind}`;

  try {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFY_FROM;
    const to = (process.env.NOTIFY_TO || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Not configured is a warning, not an error: the submission still worked.
    // Log which piece is missing — never the key itself.
    if (!key || !from || !to.length) {
      console.warn(
        `[notify] skipped source=${source} reason=not_configured` +
        ` key=${key ? 'set' : 'missing'} from=${from ? 'set' : 'missing'} to=${to.length}`
      );
      return;
    }

    const mail = buildEmail(kind, row);

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Documented as required: "All API requests must include a User-Agent
        // header. Requests without this header will be rejected with a 403
        // status code" — blocked at the edge with error code 1010, BEFORE the
        // API sees them, so the body is not the usual JSON error shape and the
        // message says nothing about the real cause. Node's global fetch
        // happens to send "User-Agent: node", which is why a hand-rolled
        // integration often works by accident; that default is not contractual
        // across runtimes, so set it explicitly and stop thinking about it.
        'User-Agent': 'peshagi-landing/1.0',
        // Scoped to the page load, so a double-submit or a browser retry of the
        // same form collapses into one email (Resend remembers a key for 24h).
        // Trade-off, stated plainly: two genuinely different enquiries sent
        // from one page load without a reload also collapse to one email. Both
        // rows are still in `contacts`, which is the record of truth.
        'Idempotency-Key': `${source}/${row.email}/${loadedAt}`.slice(0, 256),
      },
      body: JSON.stringify({
        from,
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        // snake_case. `replyTo` is a Node-SDK-only alias; send that over raw
        // HTTP and Resend drops it as an unknown field with no error, and you
        // only find out when you hit Reply and it goes to your own from address.
        //
        // And note WHICH field the visitor's address goes in. Putting it in
        // `from` would mean sending mail claiming to be gmail.com over Resend's
        // infrastructure: SPF and DKIM align to our domain, not theirs, DMARC
        // fails, Gmail junks it — and it is spoofing. reply_to gives the exact
        // behaviour actually wanted: hit Reply, it reaches the visitor.
        reply_to: row.email,
      }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });

    const ms = Date.now() - started;

    if (!res.ok) {
      // Log the error NAME, not just the status. A bare 403 is ambiguous:
      // unverified from-domain, a resend.dev sender aimed at anyone but the
      // account owner, a revoked key, or the missing User-Agent above. Truncate
      // the body — Vercel caps a log line at 256KB and a proxy in front of
      // Resend can return a whole HTML page.
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      console.error(
        `[notify] failed source=${source} status=${res.status} ms=${ms}` +
        ` daily=${res.headers.get('x-resend-daily-quota') || '-'}` +
        ` monthly=${res.headers.get('x-resend-monthly-quota') || '-'}` +
        ` retry-after=${res.headers.get('retry-after') || '-'} detail=${JSON.stringify(detail)}`
      );
      return;
    }

    // The Resend message id is the only handle tying a row in Supabase to a
    // delivery record in the Resend dashboard, and Vercel's Hobby runtime logs
    // are gone in an hour.
    const body = await res.json().catch(() => ({}));
    console.log(`[notify] sent source=${source} id=${body.id || 'unknown'} ms=${ms}`);
  } catch (err) {
    // AbortSignal.timeout rejects with name 'TimeoutError' — NOT 'AbortError'.
    // And on a DNS/TCP failure fetch rejects with a bare "TypeError: fetch
    // failed"; the actual reason (ENOTFOUND, ECONNRESET) is only on err.cause.
    const reason = err && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
    console.error(
      `[notify] failed source=${source} reason=${reason} ms=${Date.now() - started}` +
      ` name=${err && err.name} message=${err && err.message}` +
      ` cause=${(err && err.cause && (err.cause.code || err.cause.message)) || 'none'}`
    );
  }
}

/* ---------------------------------------------------------------- validation */

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
  const loadedAt = Number(body.t || 0);
  const elapsed = Date.now() - loadedAt;
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS || elapsed > MAX_FORM_AGE_MS) {
    return res.status(400).json({ error: 'Please try again' });
  }

  if (!(await turnstileOk(body.token, ip))) {
    return res.status(403).json({ error: 'Verification failed' });
  }

  const email = str(body.email, 200).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  // Set inside the try, used outside it. `pending` stays null unless a row was
  // genuinely written, which is what keeps a swallowed duplicate silent.
  let pending = null;

  try {
    if (body.form === 'signup') {
      // signups.email is UNIQUE and repeat signups are routine, so a duplicate
      // is expected here and must not read as an error to the visitor.
      const created = await insert('signups', { email }, true);
      if (created) pending = ['signup', { email }];
    } else if (body.form === 'contact') {
      const name = str(body.name, 100);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const mobile = phone(body.mobile);
      if (mobile === null) return res.status(400).json({ error: 'Invalid mobile number' });

      // The old client wrote whatever arrived; rows like purpose="test" are how
      // we know inserts bypassed the browser. Anything off the dropdown now
      // falls back rather than being stored as-is.
      const purpose = str(body.purpose, 50);
      const row = {
        name,
        email,
        mobile,
        purpose: PURPOSES.includes(purpose) ? purpose : 'General enquiry',
        message: str(body.message, 200),
      };
      // contacts has no unique constraint, so there is no duplicate to ignore
      // and this is always true. Leaving ignoreDuplicate at its default keeps it
      // that way: a 23505 here would mean someone added a constraint without
      // revisiting this code, and should still throw rather than vanish.
      await insert('contacts', row);
      pending = ['contact', row];
    } else {
      return res.status(400).json({ error: 'Unknown form' });
    }
  } catch (err) {
    // Reached only when the INSERT failed. No row exists, so a 500 is honest.
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // ------------------------------------------------------------------------
  // The row is committed. This line is the failure-isolation boundary: notify()
  // sits OUTSIDE the catch that produces the 500, so an email problem is
  // structurally incapable of being reported as a database problem. notify() is
  // also total by construction — it has no throwing path — and the .catch() is
  // insurance against a future edit introducing one, which under fluid compute
  // would surface as an unhandled rejection and drain an instance that is
  // serving other people's submissions.
  //
  // Do NOT "optimise" the await away. See the long note above notify().
  // ------------------------------------------------------------------------
  if (pending) await notify(pending[0], pending[1], loadedAt).catch(() => {});

  return res.status(200).json({ ok: true });
};

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
