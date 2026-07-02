# Chess backend (Django + Channels)

A real multiplayer backend for the chess app: WebSocket gameplay, server-side
move validation (via [`python-chess`](https://python-chess.readthedocs.io/)),
a lobby/matchmaking REST API, and reconnect handling.

The frontend keeps its own local move rules for instant feedback and the AI
opponent — this backend is only the source of truth for **online** games, so
neither player can cheat by sending an illegal move from dev tools.

## How it fits together

```
Browser  ──REST──▶  /api/rooms/create/ | join/ | quick-match/ | open/
   │                (creates a Room row, hands back a room code + a
   │                 private reconnect token)
   │
   └──WebSocket──▶  wss://.../ws/game/<CODE>/?token=<TOKEN>
                    (GameConsumer: moves, presence, chat, resign,
                     reconnect — all validated server-side)
```

- **`Room`** (game/models.py) stores the game as a FEN string + SAN move list.
  `python-chess` is used to validate legality and detect
  check/checkmate/stalemate/draw — the frontend never has to be trusted.
- **REST views** (game/views.py) handle room lifecycle: create a private
  room, join by code, quick-match into any open public room, or list open
  rooms for a simple lobby browser.
- **`GameConsumer`** (game/consumers.py) is the WebSocket endpoint for an
  individual game: it validates the mover's turn/token, applies the move
  with `python-chess`, persists it, and broadcasts the result to both
  players. It also tracks presence (connected/disconnected) and gives a
  disconnected player a grace period to reconnect before the game is
  forfeited.

## Setup

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

python manage.py migrate
python manage.py runserver      # dev server, runs over ASGI via daphne
```

That's it for local development — `channels`, `daphne`, and an in-memory
channel layer are already wired up in `settings.py`, so a single
`runserver` process handles both the REST API and WebSocket connections
with no extra services required.

### Before you deploy this for real

The defaults here are intentionally the simplest thing that works on one
process, for getting your frontend talking to a real backend quickly. Swap
these out before real users touch it:

1. **Channel layer** — `CHANNEL_LAYERS` uses `InMemoryChannelLayer`, which
   only works within a single process. Run more than one worker (you should,
   for real traffic) and two players landing on different workers won't see
   each other's moves. Switch to Redis (uncomment the block in
   `settings.py`, `pip install channels-redis`, run a Redis instance).
2. **Abandonment timer** — same issue: the 90-second "forfeit after
   disconnect" timer in `consumers.py` lives in an in-memory dict. Fine for
   one process; for multiple workers, replace it with a periodic
   Celery/Channels task that checks `Room.updated_at` + the connected flags
   in the database instead.
3. **Database** — swap the default SQLite for Postgres.
4. **`SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `CORS_ALLOW_ALL_ORIGINS`** — all
   currently set to permissive dev values in `settings.py`. Lock these down
   (env vars for the secret key, explicit host/origin allowlists, `DEBUG =
   False`).
5. Serve over **HTTPS/WSS** — browsers require WSS from an HTTPS page.

## REST API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/rooms/create/` | `{"hostColor": "w"}` (optional, defaults to `"w"`) | `{code, token, color, status}` |
| POST | `/api/rooms/join/` | `{"code": "ABCDE"}` | `{code, token, color, status}` |
| POST | `/api/rooms/quick-match/` | `{}` | `{code, token, color, status, matched}` |
| GET | `/api/rooms/open/` | – | `{rooms: [{code, hostColor, createdAt}, ...]}` |
| GET | `/api/rooms/<code>/` | – | full room state (see below) |

`token` is a private reconnect credential — store it (e.g. `localStorage`)
and don't show it to the other player. To reconnect after a dropped
connection, just open the WebSocket again with the same token; you don't
need to call the REST endpoints again.

## WebSocket protocol

Connect to `ws://<host>/ws/game/<CODE>/?token=<TOKEN>`.

**Server → client messages** (`type` field tells you which):

```jsonc
// sent once, right after connecting
{ "type": "state", "code": "ABCDE", "fen": "...", "turn": "w",
  "moveHistory": ["e4", "e5"], "status": "active", "hostColor": "w",
  "guestJoined": true, "hostConnected": true, "guestConnected": true,
  "winner": null, "resultReason": null, "updatedAt": "..." }

// after any legal move, broadcast to both players
{ "type": "move", "uci": "e2e4", "san": "e4", "fen": "...", "turn": "b",
  "inCheck": false, "status": "active", "winner": null, "resultReason": null }

// opponent connects/disconnects
{ "type": "presence", "color": "b", "connected": false }

{ "type": "chat", "color": "w", "text": "gg!" }

{ "type": "rematch_offer", "color": "w" }

// game ends (checkmate / stalemate / draw / resignation / abandonment)
{ "type": "game_over", "status": "finished", "winner": "w", "resultReason": "checkmate" }

// a move/action was rejected
{ "type": "error", "message": "It's not your turn." }
```

**Client → server messages:**

```jsonc
{ "action": "move", "uci": "e7e8q" }   // uci is "fromTosq" + optional promotion letter
{ "action": "resign" }
{ "action": "chat", "text": "good game" }
{ "action": "rematch_offer" }
```

Moves use [UCI notation](https://python-chess.readthedocs.io/en/latest/core.html#chess.Move.uci)
(`"e2e4"`, or `"e7e8q"` for a promotion) rather than the `{from:{r,c},
to:{r,c}}` shape the existing frontend engine uses internally — see the
integration notes below for the couple of small helpers you need to bridge
the two.

## Wiring this into the ChessApp frontend

The current frontend (`ChessApp.jsx`) keeps its own board array and polls
`window.storage` for online mode. To point it at this backend instead:

1. **Room lifecycle** — replace the `handleCreateRoom` / `handleJoinRoom`
   storage calls with `fetch()` calls to `/api/rooms/create/` and
   `/api/rooms/join/`; store the returned `token` (e.g. in `localStorage`,
   or in React state if you don't need reconnect-after-refresh).
2. **Live sync** — replace the polling `useEffect` with a single
   `new WebSocket(...)` connection and a `ws.onmessage` handler that
   dispatches on `type` (`state`, `move`, `presence`, `game_over`, `error`)
   the same way `applyRemoteDoc` does today.
3. **Sending a move** — convert your move object to UCI before sending:

   ```js
   const FILES = ["a","b","c","d","e","f","g","h"];
   const toUci = (move) => {
     const from = FILES[move.from.c] + (8 - move.from.r);
     const to = FILES[move.to.c] + (8 - move.to.r);
     return from + to + (move.promotion || "");
   };
   ws.send(JSON.stringify({ action: "move", uci: toUci(move) }));
   ```

4. **Applying the server's board** — the backend sends a FEN string, but
   your board is an 8x8 array. Rather than maintaining two representations,
   the simplest approach is: keep applying moves locally with your existing
   `applyMove()` (for instant feedback + move highlighting), and only use
   the server's `fen`/`status`/`winner` fields to detect drift or confirm
   game-over — since your local engine's legal-move generation already
   matches standard chess rules, the two should never actually disagree
   except when a move gets rejected, in which case trust the server's
   `error` message and roll back.

I can wire this integration directly into `ChessApp.jsx` next if you'd like
— happy to do that as a follow-up now that the backend itself is verified
working (tested: room create/join/quick-match, live moves between two
sockets, checkmate detection, illegal/out-of-turn rejection, and
disconnect/reconnect).
