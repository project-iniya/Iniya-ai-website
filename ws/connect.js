// ws/connect.js

const sdkSockets   = new Map(); // sessionId → ws
const phoneSockets = new Map(); // sessionId → ws

export function setupConnectWS(wss, redisClient) {

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/connect/sdk/')) {
      const sessionId = url.pathname.split('/connect/sdk/')[1];
      handleSDK(ws, sessionId, redisClient);

    } else if (url.pathname.startsWith('/connect/phone/')) {
      const sessionId = url.pathname.split('/connect/phone/')[1];
      handlePhone(ws, sessionId, redisClient);
    }
  });
}

// ── SDK ───────────────────────────────────────────────────────────────────────

async function handleSDK(ws, sessionId, redis) {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return ws.close(4004, 'Session not found');

  sdkSockets.set(sessionId, ws);

  // phone might have joined before sdk ws was ready
  if (phoneSockets.has(sessionId)) {
    ws.send(JSON.stringify({ event: 'client_connected' }));
  }

  ws.on('message', (data) => {
    // sdk → phone
    phoneSockets.get(sessionId)?.send(data);
  });

  ws.on('close', () => {
    sdkSockets.delete(sessionId);
    phoneSockets.get(sessionId)?.send(JSON.stringify({ event: 'sdk_disconnected' }));
  });

  ws.on('error', (err) => console.error(`[WS/SDK]   error | ${err.message}`));
}

// ── Phone ─────────────────────────────────────────────────────────────────────

async function handlePhone(ws, sessionId, redis) {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return ws.close(4004, 'Session not found');

  phoneSockets.set(sessionId, ws);

  // tell sdk the phone joined
  sdkSockets.get(sessionId)?.send(JSON.stringify({ event: 'client_connected' }));

  ws.on('message', (data) => {
    // phone → sdk (raw, untouched — binary or json, server doesn't care)
    sdkSockets.get(sessionId)?.send(data);
  });

  ws.on('close', () => {
    phoneSockets.delete(sessionId);
    sdkSockets.get(sessionId)?.send(JSON.stringify({ event: 'client_disconnected' }));
  });

  ws.on('error', (err) => console.error(`[WS/Phone] error | ${err.message}`));
}