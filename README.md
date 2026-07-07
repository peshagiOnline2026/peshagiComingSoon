# Peshagi — Coming Soon (Figma clone)

A pixel-faithful, responsive clone of the Peshagi "Coming Soon" landing page
(Figma: `Peshagi_GUI`). It's a **fully static site** (HTML/CSS/JS, no build, no
server) whose forms save submissions directly to **Supabase** (Postgres).

## Structure

```
public/                 ← the whole site; host this folder anywhere
  index.html            markup + scripts (char-counter + Supabase form submit)
  styles.css            all styling (desktop-first, responsive to mobile)
  assets/               SVG + image assets from Figma
supabase/schema.sql     tables + insert-only RLS policies (run once in Supabase)
```

## Run it

It's static — just open `public/index.html`, or serve the folder:

```bash
cd public && python3 -m http.server 8000    # → http://localhost:8000
```

The forms need your Supabase keys (below) to actually store data.

## Storing form submissions (Supabase)

The two forms insert straight into Supabase from the browser. That's safe
because Row-Level Security allows the public key to **INSERT only** — it can't
read, edit, or delete anyone's data.

- **Hero form** → `signups` table `{ email }` (email column is unique → no dupes)
- **Contact form** → `contacts` table `{ name, email, mobile, purpose, message }`

**Setup (free tier):**

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste `supabase/schema.sql` → **Run** (creates the tables +
   security policies).
3. **Project Settings → API** → copy the **Project URL** and the **anon public**
   key.
4. Paste both into the clearly-marked `SUPABASE_URL` / `SUPABASE_ANON_KEY`
   constants near the bottom of `public/index.html`.
5. Open the site and submit — rows appear in **Table Editor → signups / contacts**.

**Deploy:** drop the `public/` folder on any static host — Vercel, Netlify,
Cloudflare Pages, GitHub Pages — all free. No server to run.

> Free-tier note: a Supabase project **pauses after ~1 week of inactivity**
> (submissions fail until it's resumed). Once you're promoting the page you'll
> have traffic; otherwise keep it awake with a free scheduled ping
> (e.g. cron-job.org) or upgrade to Pro to remove pausing.

## Sections

Hero (logo, "Coming Soon", email capture, audio controls) → About ("Relating to
us" + big headline) → Leaf divider → Video → Contact form → Footer.

## Responsive

Built from two Figma frames — desktop (`2001:221`) and mobile (`2001:731`):

- **Desktop** — two-column about (text | headline), leaf centered below, audio
  controls, email/mobile fields side by side.
- **Mobile** (≤600px) — centered about content with the leaf divider between the
  paragraph and headline, single-column form, no audio controls, and the mobile
  type scale. The leaf reflow is handled with CSS `grid-template-areas`
  (`"left right" / "leaf leaf"` → `"left" / "leaf" / "right"`), so no markup is
  duplicated.

## Notes / substitutions

- **Script font** — the design uses *Shotflick Demo* (a proprietary face). This
  clone uses **Dancing Script** (Google Fonts) as a free stand-in for the
  "Relating to us" / "Get in touch" headings. Swap the `<link>` and the
  `--script`/`.script` font-family if you have the licensed font.
- **Body font** — Poppins (Google Fonts), matching the design.
- **Hero background** — uses `assets/img_BG.png` (botanical photo) with a
  brand-green overlay in `.hero__bg` for text legibility. To use a looping
  background video instead, swap the `url(...)` for a `<video>` and keep the
  overlay; the mute/pause audio controls are already wired for that.
- **Video section** — uses `assets/1 1.png` as the still in `.video__frame`,
  with a dark overlay + play button. Replace the CSS `background` with a real
  `<video poster="assets/1 1.png">` to make it playable.
- **Big headline** — "HEALING IS WHAT OUR VISION IS LOREM IPS" was a flattened
  image in Figma; rebuilt here as live, editable text.
- The design's placeholder copy (Ranavat lorem text) and typos (e.g. "Emil
  address") were cleaned up.
