# Online Chess — Django/Channels backend + React frontend

This project is two apps that talk to each other:

```
chess_frontend/   Vite + React UI (board, local engine for AI/pass-and-play,
                   and a real online mode wired to the backend below)
chess_backend/    Django + Channels API: room creation/matchmaking (REST)
                   and live gameplay (WebSocket), with python-chess as the
                   server-side authority so nobody can cheat from devtools
```

**What changed from the zip you uploaded:** the frontend's "Play Online" mode
was a self-contained mock — it stored game state in `window.storage`, a
key/value API that only exists inside Claude's artifact sandbox, and it never
called the Django backend at all. It's now rewired to actually use it:

- `chess_frontend/src/api.js` — REST calls (`create/join/quick-match`) and
  builds the WebSocket URL.
- `chess_frontend/src/App.jsx` — the online-mode logic (`connectOnlineSocket`,
  `applyServerState`, `applyServerMove`, `submitOnlineMove`, etc.) now sends
  moves to `wss://.../ws/game/<code>/` and rebuilds board state from the FEN
  the server broadcasts back, instead of writing to local mock storage. It
  also gained a **Quick Match** button (the backend already supported instant
  pairing; the old frontend didn't expose it).
- `chess_backend/` — unchanged gameplay logic, but `settings.py` is now driven
  by environment variables (`DJANGO_SECRET_KEY`, `DJANGO_DEBUG`,
  `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `DATABASE_URL`,
  `REDIS_URL`) instead of hardcoded dev values, plus a `Dockerfile`,
  `Procfile`, and `whitenoise`/`dj-database-url` so it's deployable as-is.

I tested the full loop locally (REST create/join → two WebSocket clients →
moves broadcast and applied on both sides) before handing this back — see
the bottom of this file if you want to repeat that.

## 1. Run it locally

**Backend**
```bash
cd chess_backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver    # http://127.0.0.1:8000
```
.\venv\Scripts\Activate.ps1
**Frontend** (separate terminal)
```bash
cd chess_frontend
npm install
cp .env.example .env          # defaults already point at localhost:8000
npm run dev                   # http://127.0.0.1:5173
```

Open two browser windows at `localhost:5173`, pick **Play Online** in both,
create a room in one and join with the code (or use **Quick Match** in both)
— moves now sync through the real backend.

## 2. Deploy it for free (WebSockets, so Render/Railway are out)

Django Channels needs a host that keeps a real, long-lived process alive for
WebSocket connections — that rules out pure serverless platforms (Vercel/
Netlify functions, AWS Lambda) alongside Render/Railway. As of mid-2026,
Fly.io and Koyeb also dropped their free tiers (Koyeb's closed to new
signups after its Feb 2026 acquisition by Mistral). The two options below
are the ones that are still genuinely free right now:

### Backend option A — Google Cloud Run (easiest genuinely-free option)

Cloud Run has an *always-free* monthly quota (not a trial) — roughly 2M
requests and 180,000 vCPU-seconds/month — and supports WebSockets natively.
The `Dockerfile` in `chess_backend/` is ready for it as-is.

```bash
cd chess_backend
gcloud run deploy chess-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances=1 \
  --set-env-vars DJANGO_SECRET_KEY=<generate-one>,DJANGO_DEBUG=False,DJANGO_ALLOWED_HOSTS=*,CORS_ALLOWED_ORIGINS=https://<your-frontend-domain>
```
`--min-instances=1` matters here: it keeps exactly one container warm, which
is important because this app's default channel layer and matchmaking are
in-memory — if Cloud Run scaled to 2+ instances, players could land on
different instances and never see each other. (A free Google account
requires a credit card on file, but you won't be charged while inside the
free quota.)

### Backend option B — Oracle Cloud "Always Free" VPS (most robust, more setup)

Oracle's Always Free tier is uncapped in time (not a trial) and gives you a
real VM (commonly an ARM instance with several cores/GBs of RAM) — no cold
starts, no request quotas. More setup work since you're admin-ing a real
server:

```bash
# on the VM
sudo apt update && sudo apt install -y docker.io
git clone <your-repo> && cd chess_backend
docker build -t chess-backend .
docker run -d -p 80:8000 --env-file .env --restart unless-stopped chess-backend
```
Point a free domain (or the VM's public IP) at it; add Nginx + Let's Encrypt
if you want HTTPS/`wss://` (recommended — browsers block mixed-content
`ws://` calls from an `https://` frontend).

### A note on both options

`Room` state defaults to SQLite, whose file lives inside the container. On
Cloud Run especially, a redeploy/restart wipes it — fine for casual games,
but if you want rooms/results to survive restarts, set `DATABASE_URL` to a
free Postgres instance (Neon or Supabase both have no-credit-card free
tiers) and the settings already pick it up automatically.

### Frontend — any static host works (no WebSocket needed here)

The frontend is a plain static build (`npm run build` → `chess_frontend/dist`),
so **Vercel**, **Netlify**, **Cloudflare Pages**, or **GitHub Pages** all work
great and are free with no relevant caveats. Vercel is the fastest path:

```bash
cd chess_frontend
npm i -g vercel
vercel deploy --prod
```
Then set the environment variable in the host's dashboard:
```
VITE_API_BASE_URL=https://<your-backend-url>
```
(rebuild after setting it — Vite bakes env vars in at build time). Also
update the backend's `CORS_ALLOWED_ORIGINS` to that exact frontend URL once
you know it.

## 3. Verifying the backend yourself

```bash
curl -X POST http://127.0.0.1:8000/api/rooms/create/ \
  -H "Content-Type: application/json" -d '{"hostColor":"w"}'
# => {"code": "...", "token": "...", "color": "w", "status": "waiting"}
```
Then connect a WebSocket to `ws://127.0.0.1:8000/ws/game/<code>/?token=<token>`
and send `{"action":"move","uci":"e2e4"}` — you'll get a `move` broadcast back
with the updated FEN.
