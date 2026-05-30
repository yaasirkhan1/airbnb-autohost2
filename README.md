# 🏠 Airbnb AutoHost

24/7 auto-reply agent for Airbnb guests — powered by Claude AI.
Replies to guests within seconds, 5-minute cancellation window, live dashboard.

---

## Deploy to Railway (step by step)

### Step 1 — Upload this code to GitHub

1. Go to github.com → sign in (or create free account)
2. Click **New repository** → name it `airbnb-autohost` → Create
3. Upload all these files (drag and drop into the repo page)

### Step 2 — Deploy on Railway

1. Go to **railway.app** → sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select `airbnb-autohost`
4. Railway will auto-detect Node.js and deploy it

### Step 3 — Add environment variables

In Railway → your project → **Variables** tab, add:

| Key | Value |
|-----|-------|
| `HOSPITABLE_API_KEY` | Your Hospitable Bearer token |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `HOST_NAME` | Your name (e.g. Maria) |
| `HOST_TONE` | warm and friendly |
| `CHECKIN_TIME` | 3:00 PM |
| `CHECKOUT_TIME` | 11:00 AM |
| `HOUSE_RULES` | No smoking, no parties, quiet after 10pm |
| `EXTRA_CONTEXT` | Parking tips, wifi, nearby spots, etc. |
| `REPLY_DELAY_MINUTES` | 5 |
| `AUTOSEND` | true |

### Step 4 — Get your public URL

In Railway → your project → **Settings → Networking → Generate Domain**
You'll get a URL like: `https://airbnb-autohost-production.up.railway.app`

### Step 5 — Add webhook in Hospitable

1. Log into Hospitable
2. Go to **Settings → API → Webhooks**
3. Click **Add webhook**
4. URL: `https://YOUR-RAILWAY-URL/webhook/hospitable`
5. Events: select **Messages**
6. Save

### Step 6 — Test it

Send a message to yourself on Airbnb (or have a friend test).
Watch the dashboard at your Railway URL — you'll see the pending reply with a countdown.

---

## Dashboard

Visit your Railway URL in any browser on any device:
- See all pending replies with countdown timers
- Edit a reply before it sends
- Cancel a reply
- Send immediately
- View activity log

---

## Costs

| Service | Cost |
|---------|------|
| Railway | ~$5/month (Hobby plan) |
| Anthropic API | ~$2–8/month for 6 listings |
| Hospitable | Included in your plan |
| **Total** | **~$7–13/month** |

---

## Customizing replies

Edit the `HOST_SETTINGS` variables in Railway to change:
- Host name and tone
- Check-in/out times
- House rules
- Extra context (parking, wifi, etc.)

No code changes needed — just update the variables and Railway redeploys automatically.
