/**
 * GET /api/keepalive — stops Supabase pausing the project for inactivity.
 *
 * Free-plan projects are paused after 7 days without "sufficient user database
 * activity", and this page can easily go a week without a form submission. Once
 * paused, every /api/submit insert fails until someone restores the project by
 * hand — so the forms go down precisely when nobody is looking.
 *
 * Vercel Cron calls this twice a day (vercel.json → crons). Hobby only allows a
 * cron expression that fires once a day, hence two daily entries rather than
 * one every-12-hours expression. Supabase says "a few user requests to the
 * database each day" is typically enough, and cron delivery is best-effort, so
 * two gives margin.
 *
 * Each run upserts the single row in public.keepalive. A write rather than a
 * bare connection, because a connection that does nothing is not reliably
 * counted as activity. Check `pinged_at` in that table to see the last
 * successful run — Hobby runtime logs are gone in an hour.
 *
 * This is a workaround, not a guarantee: Supabase does not publish the exact
 * threshold. Only a paid plan is exempt from pausing outright.
 *
 * Required env vars (Vercel → Settings → Environment Variables):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  same values api/submit.js uses
 *   CRON_SECRET  random string, 16+ chars. Vercel sends it on every cron call
 *                as "Authorization: Bearer <value>". Unset, this endpoint
 *                refuses everything — the cron included.
 *
 * Run supabase/keepalive.sql before deploying this, or every ping fails.
 */

const SUPABASE_TIMEOUT_MS = 8000;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Fail closed: with CRON_SECRET unset, "Bearer undefined" must not match.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[keepalive] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const started = Date.now();

  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/keepalive`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        // Upsert on the primary key: the same row is overwritten every run.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: 1, pinged_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });

    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 500);
      console.error(
        `[keepalive] failed status=${r.status} ms=${Date.now() - started} detail=${JSON.stringify(detail)}`
      );
      return res.status(502).json({ ok: false });
    }
  } catch (err) {
    // Same error shapes as notify() in api/submit.js: TimeoutError on the
    // abort, a bare "fetch failed" with the real reason on err.cause otherwise.
    const reason = err && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
    console.error(
      `[keepalive] failed reason=${reason} ms=${Date.now() - started}` +
      ` message=${err && err.message}` +
      ` cause=${(err && err.cause && (err.cause.code || err.cause.message)) || 'none'}`
    );
    return res.status(502).json({ ok: false });
  }

  console.log(`[keepalive] ok ms=${Date.now() - started}`);
  return res.status(200).json({ ok: true });
};
