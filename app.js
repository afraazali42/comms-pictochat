// comms — pictochat prototype
//
// drawings are stored as STROKE DATA (vector), not rasterized images.
// each stroke = { c: color, s: size, p: [[x,y], ...] } in CSS pixels.
// massively lighter than PNGs, crisp at any size, serializes easily for P2P.

// ESM imports (this script is loaded with type="module")
// Nostr relays are real-time event streams — sub-second peer discovery and
// fast reconnect after a tab refresh. Much smoother than BitTorrent
// trackers (which only re-announce every 2 minutes).
import { joinRoom } from 'https://esm.sh/@trystero-p2p/nostr';

// ------- Config -------
const COLORS = [
  '#000000', '#7F7F7F', '#880015', '#ED1C24',
  '#FF7F27', '#FFF200', '#22B14C', '#00A2E8',
  '#3F48CC', '#A349A4', '#FFFFFF', '#C3C3C3',
  '#B97A57', '#FFAEC9', '#FFC90E', '#B5E61D',
];
const MAX_MESSAGES   = 100;
const DRAG_THRESHOLD = 5;

// ------- Refs -------
const composeArea  = document.querySelector('.compose-area');
const canvas       = document.getElementById('composeCanvas');
const ctx          = canvas.getContext('2d');
const messageInput = document.getElementById('messageInput');
const messageLog   = document.getElementById('messageLog');
const usernameInput= document.getElementById('username');
const paletteEl    = document.getElementById('palette');

// ------- Compose canvas backing-store sizing -------
const dpr = window.devicePixelRatio || 1;
function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.scale(dpr, dpr);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  // Replay current strokes onto the resized canvas so in-progress
  // drawings survive a window resize.
  for (const s of messageStrokes) drawStroke(ctx, s);
}
let resizeRaf;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(sizeCanvas);
});

// ------- Persistence (localStorage) -------
const STORE = {
  size:  'comms.pen.size',
  color: 'comms.pen.color',
  name:  'comms.name',
};
function storeGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Restore display name
const savedName = storeGet(STORE.name, '');
if (savedName) usernameInput.value = savedName;
usernameInput.addEventListener('input', () => storeSet(STORE.name, usernameInput.value));

// ------- Drawing state -------
let currentSize    = parseInt(storeGet(STORE.size, '4'), 10);
if (![2, 4, 8].includes(currentSize)) currentSize = 4;
let currentColor   = storeGet(STORE.color, '#000000');
if (!COLORS.includes(currentColor)) currentColor = '#000000';
let downStart      = null;
let drawing        = false;
let currentStroke  = null;        // active stroke being recorded
let messageStrokes = [];          // committed strokes for the current message

// ------- Palette UI -------
COLORS.forEach((color) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'color-swatch' + (color === currentColor ? ' active' : '');
  btn.style.background = color;
  btn.dataset.color = color;
  btn.title = color;
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = color;
    storeSet(STORE.color, color);
  });
  paletteEl.appendChild(btn);
});

// ------- Size buttons -------
// Sync the active state to the persisted size (HTML defaults to size 4).
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === currentSize);
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSize = parseInt(btn.dataset.size, 10);
    storeSet(STORE.size, String(currentSize));
  });
});

// ------- Clear -------
document.getElementById('clearBtn').addEventListener('click', () => {
  clearDrawing();
  messageInput.focus();
});

// ------- Pointer logic: drag = draw, click = focus -------
function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  // preventDefault stops the press from blurring the textarea, so typing
  // continues to route there while the user is dragging to draw.
  e.preventDefault();
  downStart = { clientX: e.clientX, clientY: e.clientY };
  drawing = false;
  currentStroke = null;
  canvas.setPointerCapture(e.pointerId);
  if (document.activeElement !== usernameInput) {
    messageInput.focus();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!downStart) return;
  if (!drawing) {
    const dx = e.clientX - downStart.clientX;
    const dy = e.clientY - downStart.clientY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drawing = true;
    const r = canvas.getBoundingClientRect();
    const startX = downStart.clientX - r.left;
    const startY = downStart.clientY - r.top;
    currentStroke = { c: currentColor, s: currentSize, p: [[startX, startY]] };
    // dot at start so a quick flick still marks
    ctx.beginPath();
    ctx.arc(startX, startY, currentSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = currentColor;
    ctx.fill();
  }
  const p = localPos(e);
  const last = currentStroke.p[currentStroke.p.length - 1];
  ctx.beginPath();
  ctx.moveTo(last[0], last[1]);
  ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = currentStroke.c;
  ctx.lineWidth   = currentStroke.s;
  ctx.stroke();
  currentStroke.p.push([p.x, p.y]);
});

canvas.addEventListener('pointerup', () => {
  if (drawing && currentStroke) messageStrokes.push(currentStroke);
  messageInput.focus();
  downStart     = null;
  drawing       = false;
  currentStroke = null;
});

canvas.addEventListener('pointercancel', () => {
  downStart = null;
  drawing = false;
  currentStroke = null;
});

// ------- Send -------
document.getElementById('sendBtn').addEventListener('click', send);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

function send() {
  const text = messageInput.value.trim();
  const drew = messageStrokes.length > 0;
  if (!text && !drew) {
    flashCompose();
    return;
  }
  const name = (usernameInput.value || '').trim() || 'anon';

  // Capture the input field's dimensions at send time. Used both to render
  // the strokes proportionally AND to enforce min-height on every message
  // bubble so it matches the input field's aspect — no cropping, no shrinking.
  const r = canvas.getBoundingClientRect();
  const fieldW = r.width;
  const fieldH = r.height;
  const drawing = drew
    ? { strokes: messageStrokes.slice(), w: fieldW, h: fieldH }
    : null;

  appendMessage(name, text, drawing, fieldW, fieldH, true);

  // Broadcast to peers. Network failures are silent — your own message
  // already shows up locally regardless of whether it reached anyone.
  if (broadcastMessage) {
    try {
      broadcastMessage({ name, text, drawing, fieldW, fieldH });
    } catch (err) {
      console.warn('[comms] broadcast failed:', err);
    }
  }

  messageInput.value = '';
  clearDrawing();
  messageInput.focus();
}

function clearDrawing() {
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  messageStrokes = [];
  currentStroke = null;
}

// Re-render every committed stroke onto the compose canvas. Used by undo.
function redrawAllStrokes() {
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  for (const s of messageStrokes) drawStroke(ctx, s);
}

// Undo (Cmd/Ctrl+Z): pop the most recent stroke, re-render. Falls through to
// the textarea's native undo when there are no strokes left to remove.
window.addEventListener('keydown', (e) => {
  if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    if (messageStrokes.length > 0) {
      e.preventDefault();
      messageStrokes.pop();
      redrawAllStrokes();
    }
  }
});

function flashCompose() {
  composeArea.classList.add('compose-area--flash');
  setTimeout(() => composeArea.classList.remove('compose-area--flash'), 240);
}

// ------- Append a message -------
// Each message stores its own data on its DOM node so the slideshow / flipnote
// playback feature can replay later messages inside an earlier message's bubble.
function appendMessage(name, text, drawing, fieldW, fieldH, isMe) {
  const data = { name, text, drawing, fieldW, fieldH, isMe, time: formatTime() };

  const msg = document.createElement('div');
  msg.className = 'message' + (isMe ? ' me' : '');
  msg._data = data;

  const header = document.createElement('div');
  header.className = 'message-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'message-name';
  const timeEl = document.createElement('span');
  timeEl.className = 'message-time';
  header.appendChild(nameEl);
  header.appendChild(timeEl);
  msg.appendChild(header);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  // Lock every bubble to the input field's aspect ratio at send time.
  // Long text grows the bubble taller; shorter content keeps the full height.
  bubble.style.aspectRatio = `${fieldW} / ${fieldH}`;

  // Play button — persists across slideshow frame swaps so its handler stays bound.
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'message-play';
  playBtn.title = 'play forward (flipnote-style)';
  playBtn.textContent = '▶';
  playBtn.addEventListener('click', () => playFollowups(msg));
  bubble.appendChild(playBtn);

  msg.appendChild(bubble);

  renderHeader(header, data);
  renderBubble(bubble, data);

  // Only auto-scroll if the user was already pinned to the bottom. This way
  // someone reading older messages — even if they're the sender themselves —
  // won't get yanked back down. They use the ▼ button when they're ready.
  const wasAtBottom = isAtBottom(messageLog);

  messageLog.appendChild(msg);

  if (wasAtBottom) {
    messageLog.scrollTop = messageLog.scrollHeight;
    // Re-pin after async stroke painting may have grown the layout
    requestAnimationFrame(() => requestAnimationFrame(() => {
      messageLog.scrollTop = messageLog.scrollHeight;
    }));
  }

  while (messageLog.children.length > MAX_MESSAGES) {
    messageLog.removeChild(messageLog.firstChild);
  }
}

// True if the message log is scrolled to (or within a few pixels of) bottom.
function isAtBottom(el, threshold = 6) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

// ▼ button — manual scroll to bottom
document.getElementById('scrollBottomBtn').addEventListener('click', () => {
  messageLog.scrollTop = messageLog.scrollHeight;
});

// Update only the header content. Used for both initial render and slideshow.
function renderHeader(header, data) {
  header.querySelector('.message-name').textContent = data.name;
  header.querySelector('.message-time').textContent = data.time;
}

// Wipe the bubble's text + strokes (preserving the play button) and rebuild
// from data. Called for initial render and again for each slideshow frame.
function renderBubble(bubble, data) {
  bubble.querySelectorAll('.message-text, .message-strokes').forEach(el => el.remove());
  const playBtn = bubble.querySelector('.message-play');

  if (data.text) {
    const t = document.createElement('div');
    t.className = 'message-text';
    t.textContent = data.text;
    bubble.insertBefore(t, playBtn);
  }
  if (data.drawing) {
    const c = document.createElement('canvas');
    c.className = 'message-strokes' + (data.text ? '' : ' solo');
    bubble.insertBefore(c, playBtn);
    requestAnimationFrame(() => paintStrokes(c, data.drawing));
  }
}

// Slideshow: replay every subsequent message inside startMsg's bubble,
// flipnote-style. Bubble height is locked so longer follow-ups don't reflow.
const FLIPNOTE_FRAME_MS = 280;
function playFollowups(startMsg) {
  if (startMsg._playing) return;
  const all = Array.from(messageLog.children);
  const startIdx = all.indexOf(startMsg);
  const followups = all.slice(startIdx + 1).map(el => el._data);
  if (followups.length === 0) return;

  startMsg._playing = true;
  const bubble = startMsg.querySelector('.message-bubble');
  const header = startMsg.querySelector('.message-header');
  const originalData = startMsg._data;

  // Lock both width and height to the bubble's rendered sub-pixel dimensions
  // (via getBoundingClientRect, which returns floats — offsetWidth/Height
  // round to integers and can leave a 1-pixel shift). Also disable the
  // aspect-ratio rule so it can't override the explicit lock.
  const r = bubble.getBoundingClientRect();
  bubble.style.width        = r.width  + 'px';
  bubble.style.height       = r.height + 'px';
  bubble.style.aspectRatio  = 'auto';

  function show(data) {
    renderHeader(header, data);
    renderBubble(bubble, data);
    startMsg.classList.toggle('me', !!data.isMe);
  }

  let i = 0;
  function step() {
    if (i < followups.length) {
      show(followups[i++]);
      setTimeout(step, FLIPNOTE_FRAME_MS);
    } else {
      show(originalData);
      bubble.style.width        = '';
      bubble.style.height       = '';
      bubble.style.aspectRatio  = `${originalData.fieldW} / ${originalData.fieldH}`;
      startMsg._playing = false;
    }
  }
  step();
}

// ------- Stroke rendering -------
// Render onto a 1x backing store (no DPR upscaling) so the result is
// naturally pixelated — matches the lightweight pictochat aesthetic and
// halves the bitmap memory on retina screens.
function paintStrokes(canvasEl, drawing) {
  const rect = canvasEl.getBoundingClientRect();
  const dispW = Math.round(rect.width);
  if (dispW === 0) {
    requestAnimationFrame(() => paintStrokes(canvasEl, drawing));
    return;
  }
  const dispH = Math.round(dispW * (drawing.h / drawing.w));
  canvasEl.style.height = dispH + 'px';
  canvasEl.width  = dispW;
  canvasEl.height = dispH;
  const c = canvasEl.getContext('2d');
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const sx = dispW / drawing.w;
  const sy = dispH / drawing.h;
  const lineScale = Math.min(sx, sy);
  for (const s of drawing.strokes) drawStroke(c, s, sx, sy, lineScale);
}

function drawStroke(ctx, stroke, sx = 1, sy = 1, lineScale = 1) {
  const pts = stroke.p;
  ctx.strokeStyle = stroke.c;
  ctx.fillStyle   = stroke.c;
  ctx.lineWidth   = stroke.s * lineScale;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * sx, pts[0][1] * sy, (stroke.s * lineScale) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.arc(pts[0][0] * sx, pts[0][1] * sy, (stroke.s * lineScale) / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i][0] * sx, pts[i][1] * sy);
  }
  ctx.stroke();
}

// ------- Helpers -------
function formatTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

// ------- Always-on focus -------
// No guard around active drags — we want the textarea to recover focus
// even if the canvas press momentarily blurred it, so the user can type
// and draw at the same time.
function ensureFocus() {
  const active = document.activeElement;
  if (active !== usernameInput && active !== messageInput) {
    messageInput.focus();
    const len = messageInput.value.length;
    messageInput.setSelectionRange(len, len);
  }
}
messageInput .addEventListener('blur',  () => setTimeout(ensureFocus, 0));
usernameInput.addEventListener('blur',  () => setTimeout(ensureFocus, 0));
window       .addEventListener('focus', () => setTimeout(ensureFocus, 0));

setTimeout(ensureFocus, 80);
sizeCanvas();

// ------- Networking: discover public IP, hash to room key, join room -------
//
// "Same WiFi → same chatroom" works because everyone on a NAT shares the same
// public egress IP. Each peer hashes that IP into a room key, joins via
// Trystero (which uses public BitTorrent trackers as a free signaling layer),
// and then chats peer-to-peer over WebRTC DataChannels.

const ROOM_SALT = 'comms-pictochat-v1';
const STUN_URL  = 'stun:stun.l.google.com:19302';

// Pull our public IP from a WebRTC server-reflexive ICE candidate. No
// third-party HTTP API needed — STUN is free, fast, and only sees the
// minimum (the egress IP) that we'd be revealing to peers anyway.
function getPublicIP() {
  return new Promise((resolve, reject) => {
    let done = false;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
    pc.createDataChannel('discover');
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .catch(reject);

    pc.addEventListener('icecandidate', (e) => {
      if (done || !e.candidate) return;
      const cand = e.candidate.candidate || '';
      if (!cand.includes('srflx')) return; // only server-reflexive (public) candidates
      const m = cand.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (!m) return;
      done = true;
      pc.close();
      resolve(m[1]);
    });

    setTimeout(() => {
      if (done) return;
      done = true;
      pc.close();
      reject(new Error('public IP discovery timed out'));
    }, 5000);
  });
}

// SHA-256(ip + salt) → 32 hex chars. The salt isn't a real privacy boundary
// (anyone with the source can hash known IPs), but it does prevent passive
// observation of "this room hash = this exact public IP" without effort.
async function hashRoomKey(ip) {
  const buf = new TextEncoder().encode(ip + '.' + ROOM_SALT);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

// Will be set to Trystero's send function once the room is joined.
// send() checks this to broadcast outgoing messages.
let broadcastMessage = null;

(async () => {
  try {
    console.log('[comms] discovering public IP via STUN…');
    const ip = await getPublicIP();
    console.log('[comms] public IP:', ip);

    const roomKey = await hashRoomKey(ip);
    console.log('[comms] room key:', roomKey);

    console.log('[comms] joining room…');
    const room = joinRoom({ appId: 'comms-pictochat' }, roomKey);
    window._commsRoom = room; // exposed for debugging

    room.onPeerJoin((peerId) => console.log('[comms] peer joined:', peerId));
    room.onPeerLeave((peerId) => console.log('[comms] peer left:', peerId));

    // Wire a typed action channel for messages. makeAction returns
    // [send, receive]. We just use one channel for everything for now.
    const [sendMsg, onMsg] = room.makeAction('msg');
    broadcastMessage = sendMsg;

    onMsg((data /* , peerId */) => {
      if (!data || typeof data !== 'object') return;
      // Render incoming peer message — isMe = false
      appendMessage(
        data.name   || 'anon',
        data.text   || '',
        data.drawing || null,
        data.fieldW || 480,
        data.fieldH || 90,
        false
      );
    });

    console.log('[comms] joined room — waiting for peers');
  } catch (err) {
    console.error('[comms] networking failed:', err);
  }
})();

// ------- Visual viewport tracking (mobile keyboard handling) -------
// iOS Safari doesn't reliably update 100dvh when the on-screen keyboard
// opens, so we track window.visualViewport.height directly and expose it
// as --app-h. The mobile @media rule uses this var for the app shell's
// height — when the keyboard slides up, the app shrinks to fit immediately.
function updateAppHeight() {
  const root = document.documentElement;
  if (window.visualViewport) {
    const vv = window.visualViewport;
    root.style.setProperty('--app-h',   vv.height    + 'px');
    // The visual viewport can be scrolled by iOS independently of the
    // document (e.g. when the keyboard opens it shifts the visible area).
    // We mirror its offsetTop so position:fixed elements track it instead
    // of staying anchored to the now-off-screen layout viewport.
    root.style.setProperty('--app-top', vv.offsetTop + 'px');
  } else {
    root.style.setProperty('--app-h',   window.innerHeight + 'px');
    root.style.setProperty('--app-top', '0px');
  }
}
updateAppHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateAppHeight);
  window.visualViewport.addEventListener('scroll', updateAppHeight);
}
window.addEventListener('resize', updateAppHeight);
window.addEventListener('orientationchange', updateAppHeight);

// ------- Sync corner-button size -------
// The slideshow play button on each message mirrors the send button's exact
// dimensions for visual symmetry. We measure once after layout, then again
// on resize (in case the compose area's width changed).
function syncCornerBtnSize() {
  // Send button is now a fixed 80×30 across all devices, but we still
  // measure here in case the design changes — keeps the play button in
  // lockstep with whatever the send button actually is.
  const sb = document.getElementById('sendBtn');
  if (!sb) return;
  const r = sb.getBoundingClientRect();
  if (r.width === 0) return;
  document.documentElement.style.setProperty('--corner-btn-w', r.width + 'px');
  document.documentElement.style.setProperty('--corner-btn-h', r.height + 'px');
}
requestAnimationFrame(syncCornerBtnSize);
window.addEventListener('load', syncCornerBtnSize);
window.addEventListener('resize', () => requestAnimationFrame(syncCornerBtnSize));
