// Talks to the Django/Channels chess backend.
// Configure the backend URL via a .env file (see .env.example):
//   VITE_API_BASE_URL=https://your-backend.example.com
// The WebSocket base is derived automatically (http->ws, https->wss) unless
// VITE_WS_BASE_URL is set explicitly.

const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const RAW_WS_BASE =
  (import.meta.env.VITE_WS_BASE_URL || RAW_API_BASE.replace(/^http/, "ws")).replace(/\/+$/, "");

async function postJSON(path, body) {
  let res;
  try {
    res = await fetch(`${RAW_API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    throw new Error("Couldn't reach the game server. Is the backend running / deployed?");
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* ignore, empty/invalid body */
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function getJSON(path) {
  let res;
  try {
    res = await fetch(`${RAW_API_BASE}${path}`);
  } catch (e) {
    throw new Error("Couldn't reach the game server.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* ignore */
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function createRoom(hostColor = "w") {
  return postJSON("/api/rooms/create/", { hostColor });
}

export function joinRoom(code) {
  return postJSON("/api/rooms/join/", { code });
}

export function quickMatch() {
  return postJSON("/api/rooms/quick-match/", {});
}

export function roomStatus(code) {
  return getJSON(`/api/rooms/${code}/`);
}

export function wsUrlForRoom(code, token) {
  return `${RAW_WS_BASE}/ws/game/${code}/?token=${encodeURIComponent(token)}`;
}

export const API_BASE = RAW_API_BASE;
export const WS_BASE = RAW_WS_BASE;
