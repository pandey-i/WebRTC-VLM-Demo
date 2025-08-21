const state = {
  mode: 'wasm',
  pc: null,
  dc: null,
  ws: null,
  role: 'viewer',
  roomId: null,
  config: null,
  wasm: { model: null, ready: false },
  latestFrame: null,
  fpsCounter: { count: 0, lastTs: performance.now(), fps: 0 },
  metrics: { samples: [] },
  backpressure: { busy: false }
};

async function fetchConfig() {
  const res = await fetch('/config.json');
  state.config = await res.json();
  // honor server default mode unless user overrides
  state.mode = state.config.mode || 'wasm';
  document.getElementById('mode').value = state.mode;
}

async function initWasm() {
  if (state.wasm.ready) return;
  if (tf && tf.wasm && tf.wasm.setWasmPaths) {
    tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.17.0/dist/');
  }
  await tf.setBackend('wasm');
  state.wasm.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  state.wasm.ready = true;
}

function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function createPeerConnection() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
  ];
  if (state.config && state.config.turn) iceServers.push(state.config.turn);
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const remote = document.getElementById('remoteVideo');
    remote.srcObject = e.streams[0];
    // Size overlay now and whenever the video metadata loads or playback starts
    try { remote.removeEventListener('loadedmetadata', sizeOverlayToVideo); } catch {}
    try { remote.removeEventListener('play', sizeOverlayToVideo); } catch {}
    remote.addEventListener('loadedmetadata', sizeOverlayToVideo);
    remote.addEventListener('play', sizeOverlayToVideo);
    sizeOverlayToVideo();
  };
  state.dc = pc.createDataChannel('metrics');
  state.dc.onopen = () => {};
  state.dc.onmessage = (ev) => handleServerDetections(ev.data);
  return pc;
}

function connectSignaling() {
  state.ws = new WebSocket(getWsUrl());
  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({ type: 'join', role: state.role, roomId: state.roomId }));
  };
  state.ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') return;
    if (msg.type === 'ready' || msg.type === 'phone-joined') {
      if (state.role === 'viewer') await startViewerNegotiation();
      return;
    }
    if (msg.type === 'signal') await handleSignal(msg.data);
    if (msg.type === 'infer_result') {
      try { console.debug('Received infer_result (ws)', msg.frame_id, 'detections=', (msg.detections||[]).length); } catch (e) {}
      handleInferResult(msg);
    }
  };
}

function sendSignal(data, target = state.role === 'viewer' ? 'phone' : 'viewer') {
  if (!state.ws) return;
  state.ws.send(JSON.stringify({ type: 'signal', roomId: state.roomId, data, target }));
}

async function startPhone() {
  state.role = 'phone';
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 480 }, audio: false });
  document.getElementById('localVideo').srcObject = stream;
  state.pc = createPeerConnection();
  for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
  connectSignaling();
}

async function startViewerNegotiation() {
  state.pc = createPeerConnection();
  const offer = await state.pc.createOffer({ offerToReceiveVideo: true });
  await state.pc.setLocalDescription(offer);
  sendSignal({ sdp: state.pc.localDescription });
}

async function handleSignal(data) {
  if (data.sdp) {
    await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      sendSignal({ sdp: state.pc.localDescription });
    }
  } else if (data.candidate) {
    try { await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
}

function sizeOverlayToVideo() {
  const video = document.getElementById('remoteVideo');
  const canvas = document.getElementById('overlay');
  if (!video || !canvas) return;
  const rect = video.getBoundingClientRect();
  // Set CSS size
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  // Backing store size for high-DPI displays
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  // Reset and scale context to account for DPR so drawing coordinates remain in CSS pixels
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}

// WASM local inference loop on viewer when receiving remote video
async function runWasmLoop() {
  await initWasm();
  const video = document.getElementById('remoteVideo');
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');
  const process = async () => {
    if (state.mode !== 'wasm') return;
    if (video.readyState >= 2) {
      // Downscale to 320x240 for inference
      const off = document.createElement('canvas');
      off.width = 320; off.height = 240;
      const octx = off.getContext('2d');
      octx.drawImage(video, 0, 0, off.width, off.height);
      const t0 = performance.now();
      const preds = await state.wasm.model.detect(off);
      const now = Date.now();
  // Use CSS pixel dimensions for outW/outH so drawing matches the scaled ctx
  const outW = canvas.clientWidth || (canvas.width / (window.devicePixelRatio || 1));
  const outH = canvas.clientHeight || (canvas.height / (window.devicePixelRatio || 1));
  drawOverlay(ctx, preds, off.width, off.height, outW, outH);
      updateFpsAndStats(now);
      postMetricsSample({ e2e_ms: null, fps: state.fpsCounter.fps });
    }
    // throttle to ~12 FPS
    setTimeout(process, 80);
  };
  process();
}

function drawOverlay(ctx, preds, srcW, srcH, outW, outH) {
  ctx.clearRect(0, 0, outW, outH);
  ctx.lineWidth = 2; ctx.strokeStyle = '#00e5ff'; ctx.font = '12px monospace'; ctx.fillStyle = '#00e5ff';
  for (const p of preds) {
    const [x, y, w, h] = p.bbox; // absolute in src pixels
    const nx1 = x / srcW, ny1 = y / srcH, nx2 = (x + w) / srcW, ny2 = (y + h) / srcH;
    const rx1 = nx1 * outW; const ry1 = ny1 * outH; const rw = (nx2 - nx1) * outW; const rh = (ny2 - ny1) * outH;
    ctx.strokeRect(rx1, ry1, rw, rh);
    const label = `${p.class} ${(p.score * 100).toFixed(1)}%`;
    ctx.fillText(label, rx1 + 4, Math.max(12, ry1 - 4));
  }
}

function updateFpsAndStats(nowMs) {
  const fc = state.fpsCounter;
  fc.count++;
  const now = performance.now();
  if (now - fc.lastTs > 1000) {
    fc.fps = Math.round((fc.count * 1000) / (now - fc.lastTs));
    fc.count = 0; fc.lastTs = now;
    renderStats();
  }
}

function renderStats() {
  const s = document.getElementById('stats');
  const latest = state.metrics.samples.slice(-1)[0] || {};
  s.textContent = JSON.stringify({
    mode: state.mode,
    fps: state.fpsCounter.fps,
    e2e_p95_ms: latest.e2e_p95_ms || null,
    downlink_kbps: latest.downlink_kbps || null
  }, null, 2);
}

function postMetricsSample(sample) {
  // accumulate locally and POST periodically
  state.metrics.samples.push({ ...sample, t: Date.now() });
  if (state.metrics.samples.length >= 10) {
    const payload = { samples: state.metrics.samples.splice(0) };
    fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
  }
}

// Server mode: phone encodes stills at limited rate and sends to server WS for inference
async function serverSendFrameLoop() {
  if (state.role !== 'phone' || state.mode !== 'server') return;
  const video = document.getElementById('localVideo');
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const ws = state.ws;
  const tick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return setTimeout(tick, 200);
    if (video.readyState >= 2 && !state.backpressure.busy) {
      state.backpressure.busy = true;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      const base64 = dataUrl.split(',')[1];
      const frame_id = Math.random().toString(36).slice(2);
      const capture_ts = Date.now();
      ws.send(JSON.stringify({ type: 'infer_frame', frame_id, capture_ts, recv_ts: Date.now(), mime: 'image/jpeg', data: base64 }));
    }
    setTimeout(tick, 80); // ~12 FPS
  };
  tick();
}

function handleInferResult(msg) {
  // Viewer overlays results with alignment using capture_ts and frame_id
  if (state.role === 'viewer') {
    const canvas = document.getElementById('overlay');
    const ctx = canvas.getContext('2d');
    // The canvas context is scaled to devicePixelRatio in sizeOverlayToVideo.
    // Treat drawing coordinates as CSS pixels by using clientWidth/clientHeight
    const outW = canvas.clientWidth || (canvas.width / (window.devicePixelRatio || 1));
    const outH = canvas.clientHeight || (canvas.height / (window.devicePixelRatio || 1));
    ctx.clearRect(0, 0, outW, outH);
    ctx.lineWidth = 2; ctx.strokeStyle = '#00e5ff'; ctx.font = '12px monospace'; ctx.fillStyle = '#00e5ff';
    for (const d of msg.detections) {
      const rx1 = d.xmin * outW;
      const ry1 = d.ymin * outH;
      const rw = (d.xmax - d.xmin) * outW;
      const rh = (d.ymax - d.ymin) * outH;
      ctx.strokeRect(rx1, ry1, rw, rh);
      const label = `${d.label} ${(d.score * 100).toFixed(1)}%`;
      ctx.fillText(label, rx1 + 4, Math.max(12, ry1 - 4));
    }
    try { console.debug('Drew overlay for frame', msg.frame_id, 'detections=', (msg.detections||[]).length); } catch (e) {}
    const e2e = Date.now() - (msg.capture_ts || Date.now());
    // Count this processed frame for FPS in server mode
    updateFpsAndStats(Date.now());
    postMetricsSample({ e2e_ms: e2e });
  }
  if (state.role === 'phone') {
    // ack received; allow sending next frame
    state.backpressure.busy = false;
  }
}

// Periodic WebRTC getStats to estimate bandwidth via deltas
(function setupStatsLoop() {
  let last = { sent: 0, recv: 0, ts: 0 };
  setInterval(async () => {
    if (!state.pc) return;
    try {
      const stats = await state.pc.getStats();
      let bytesSent = 0, bytesRecv = 0, ts = 0;
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && !r.isRemote) { bytesSent += r.bytesSent || 0; ts = Math.max(ts, r.timestamp || 0); }
        if (r.type === 'inbound-rtp' && !r.isRemote) { bytesRecv += r.bytesReceived || 0; ts = Math.max(ts, r.timestamp || 0); }
      });
      if (last.ts) {
        const dt = Math.max(1, (ts - last.ts) / 1000);
        const upKbps = Math.round(((bytesSent - last.sent) * 8) / 1000 / dt);
        const downKbps = Math.round(((bytesRecv - last.recv) * 8) / 1000 / dt);
        postMetricsSample({ uplink_kbps: upKbps, downlink_kbps: downKbps, fps: state.fpsCounter.fps || null });
      }
      last = { sent: bytesSent, recv: bytesRecv, ts };
    } catch {}
  }, 3000);
})();

// (Server FPS is derived from infer_result count; no additional timer needed)

function handleServerDetections(_str) {
  // Placeholder for future DC usage
}

function setRoomIdUI(roomId) {
  document.getElementById('roomId').value = roomId;
  const base = state.config?.publicBaseUrl || location.origin;
  const joinUrl = `${base}/?room=${encodeURIComponent(roomId)}&phone=1&mode=${encodeURIComponent(state.mode)}`;
  const qrEl = document.getElementById('qr');
  qrEl.innerHTML = '';
  // Try common global names used by different QR libraries (robust against load failures)
  const qlib = window.QRCode || window.qrcode || window.QR || null;
  if (qlib && typeof qlib.toCanvas === 'function') {
    // Most bundled browser builds expose `QRCode.toCanvas`
    try {
      qlib.toCanvas(joinUrl, { width: 200 }, (err, canvas) => {
        if (!err && canvas) qrEl.appendChild(canvas);
        else qrEl.textContent = 'Failed to render QR (library error)';
      });
      return;
    } catch (e) {
      console.warn('QRCode.toCanvas threw', e);
    }
  }

  // Fallback: if a library provides a synchronous creator (some variants), try it
  try {
    if (qlib && typeof qlib.create === 'function') {
      const node = qlib.create ? qlib.create(joinUrl, { width: 200 }) : null;
      if (node) { qrEl.appendChild(node); return; }
    }
  } catch (e) {
    console.warn('QRCode.create threw', e);
  }

  // Last-resort fallback: use a public QR generator image service so UI still works
  // This avoids a hard ReferenceError when the local script is blocked or missing.
  console.warn('QRCode library not found; using image fallback from qrserver.com');
  const img = document.createElement('img');
  img.alt = 'QR code';
  img.width = 200; img.height = 200;
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(joinUrl)}`;
  qrEl.appendChild(img);
}

async function handleStart() {
  await fetchConfig();
  const urlParams = new URLSearchParams(location.search);
  const paramRoom = urlParams.get('room');
  const isPhoneParam = urlParams.get('phone') === '1';
  const modeParam = urlParams.get('mode');
  if (modeParam) { state.mode = modeParam; document.getElementById('mode').value = state.mode; }
  const roomIdInput = document.getElementById('roomId').value.trim();
  state.roomId = roomIdInput || paramRoom || (await (await fetch('/api/new-room')).json()).roomId;
  setRoomIdUI(state.roomId);

  const isPhone = document.getElementById('isPhone').checked || isPhoneParam;
  if (isPhone) await startPhone(); else connectSignaling();
  if (!isPhone && state.mode === 'wasm') runWasmLoop();
  if (isPhone && state.mode === 'server') serverSendFrameLoop();
}

document.getElementById('startBtn').addEventListener('click', handleStart);
document.getElementById('newRoom').addEventListener('click', async () => {
  const r = await (await fetch('/api/new-room')).json();
  setRoomIdUI(r.roomId);
});
document.getElementById('mode').addEventListener('change', (e) => { state.mode = e.target.value; });
document.getElementById('showQR').addEventListener('click', () => setRoomIdUI(document.getElementById('roomId').value.trim() || state.roomId || ''));

window.addEventListener('resize', sizeOverlayToVideo);


