// Daily keep-alive: Vercel Cron calls this once a day so the free Supabase
// project sees real API activity and doesn't pause after 7 idle days.
// It only runs public.ping() (returns 1) and touches no user data.
const SUPABASE_URL = "https://uhnxxafhjgkzvcwbgggz.supabase.co";
const SUPABASE_KEY = "sb_publishable_bXskVfmRkaR6NeIQoUqP1w_mecDOyqi"; // publishable key, already public in app.js

export default async function handler(req, res) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ping`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await r.text();
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, body, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
