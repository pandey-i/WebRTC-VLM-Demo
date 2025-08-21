const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Optional localtunnel for cross-network access when enabled
let tunnel = null;
const ENABLE_TUNNEL = process.env.NGROK === '1' || process.env.LOCALTUNNEL === '1' || process.argv.includes('--ngrok') || process.argv.includes('--localtunnel');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// Simple health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve runtime config to frontend
app.get('/config.json', (_req, res) => {
  const mode = (process.env.MODE || 'wasm').toLowerCase();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || (tunnel && tunnel.url) || null;
  const turnUrl = process.env.TURN_URL || null;
  const turnUser = process.env.TURN_USERNAME || null;
  const turnCred = process.env.TURN_CREDENTIAL || null;
  res.json({
    mode,
    publicBaseUrl,
    turn: turnUrl && turnUser && turnCred ? { urls: [turnUrl], username: turnUser, credential: turnCred } : null
  });
});

// Generate a fresh room id
app.get('/api/new-room', (_req, res) => res.json({ roomId: uuidv4() }));

// Metrics snapshot store (aggregated in-memory from browser reports)
const metricsBuffer = [];
let lastMetricsAt = 0;

app.post('/api/metrics', (req, res) => {
  const payload = req.body;
  if (payload && payload.samples && Array.isArray(payload.samples)) {
    const now = Date.now();
    lastMetricsAt = now;
    for (const s of payload.samples) {
      metricsBuffer.push({ ...s, received_at: now });
    }
  }
  res.json({ ok: true });
});

// Compute metrics over a trailing window
function computeMetrics(windowSeconds = 30) {
  const cutoff = Date.now() - windowSeconds * 1000;
  const windowSamples = metricsBuffer.filter((m) => (m.received_at || 0) >= cutoff);
  const e2eLatencies = windowSamples.filter((s) => typeof s.e2e_ms === 'number').map((s) => s.e2e_ms);
  const fpsValues = windowSamples.filter((s) => typeof s.fps === 'number').map((s) => s.fps);
  const uplink = windowSamples.filter((s) => typeof s.uplink_kbps === 'number').map((s) => s.uplink_kbps);
  const downlink = windowSamples.filter((s) => typeof s.downlink_kbps === 'number').map((s) => s.downlink_kbps);
  const serverLat = windowSamples.filter((s) => typeof s.server_latency_ms === 'number').map((s) => s.server_latency_ms);
  const networkLat = windowSamples.filter((s) => typeof s.network_latency_ms === 'number').map((s) => s.network_latency_ms);

  const percentile = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  };

  const median = (arr) => percentile(arr, 50);
  const p95 = (arr) => percentile(arr, 95);

  const metrics = {
    generated_at: Date.now(),
    window_seconds: windowSeconds,
    samples: windowSamples.length,
    e2e_latency_ms_median: median(e2eLatencies),
    e2e_latency_ms_p95: p95(e2eLatencies),
    processed_fps_median: median(fpsValues),
    uplink_kbps_median: median(uplink),
    downlink_kbps_median: median(downlink),
    server_latency_ms_median: median(serverLat),
    network_latency_ms_median: median(networkLat)
  };
  return metrics;
}

app.get('/api/metrics/snapshot', (req, res) => {
  const windowSeconds = parseInt(req.query.window || '30', 10);
  res.json(computeMetrics(windowSeconds));
});

app.get('/bench/start', async (req, res) => {
  const duration = parseInt(req.query.duration || '30', 10);
  const mode = String(req.query.mode || 'server');
  const endAt = Date.now() + duration * 1000;
  // Simple delay until time elapses; assumes browser is posting metrics concurrently
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < endAt) {
    await sleep(500);
  }
  const metrics = computeMetrics(duration);
  const outDir = path.join(__dirname, '..', 'output');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, 'metrics.json');
  fs.writeFileSync(outPath, JSON.stringify({ mode, duration_s: duration, ...metrics }, null, 2));
  res.json({ ok: true, written: 'metrics.json', metrics });
});

const server = http.createServer(app);

// Signaling WS: pairs phone and viewer by roomId; also separate WS for inference
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // roomId -> { viewer: ws, phone: ws, infer: ws }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { viewer: null, phone: null, infer: null });
  return rooms.get(roomId);
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

wss.on('connection', (ws) => {
  console.log('WS connection established');
  let role = null;
  let roomId = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      // avoid logging large payloads; just parse and log the type
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.log('Failed to parse WS message (non-JSON or too large)');
      return;
    }
    const type = msg.type;
    console.log('WS message type:', type);

    if (type === 'join') {
      role = msg.role; // 'viewer' | 'phone' | 'infer'
      roomId = msg.roomId;
  console.log(`WS join: role=${role} room=${roomId}`);
      const room = getOrCreateRoom(roomId);
      room[role] = ws;
      // Notify counterpart
      if (role === 'viewer' && room.phone) safeSend(room.viewer, { type: 'ready' });
      if (role === 'phone' && room.viewer) safeSend(room.viewer, { type: 'phone-joined' });
      safeSend(ws, { type: 'joined', role, roomId });
      return;
    }

    // Relay signaling between phone and viewer
    if (type === 'signal' && roomId) {
      const room = getOrCreateRoom(roomId);
      const target = msg.target === 'phone' ? room.phone : room.viewer;
  console.log(`Relaying signal from ${role} to ${msg.target}`);
      safeSend(target, { type: 'signal', data: msg.data });
      return;
    }

    // Inference request/response over WS (server mode)
    if (type === 'infer_frame') {
      console.log('Received infer_frame', { roomId, frame_id: msg.frame_id });
      // Expect: { frame_id, capture_ts, recv_ts, mime, data: base64 }
      const { frame_id, capture_ts, recv_ts, data, mime } = msg;
      const inferenceStart = Date.now();
      try {
        const detections = await runServerInference(data, mime);
  console.log(`Inference done for frame ${frame_id}, detections=${detections.length}`);
        const inference_ts = Date.now();
        const payload = {
          type: 'infer_result',
          frame_id,
          capture_ts,
          recv_ts,
          inference_ts,
          detections
        };
        // Send to both phone (ack for backpressure) and viewer (for overlay)
        const room = roomId ? getOrCreateRoom(roomId) : null;
        if (room) {
          safeSend(room.phone, payload);
          safeSend(room.viewer, payload);
        } else {
          safeSend(ws, payload);
        }
        // Emit metrics sample opportunistically
        metricsBuffer.push({
          e2e_ms: null,
          server_latency_ms: inference_ts - (recv_ts || inferenceStart),
          network_latency_ms: (recv_ts || inference_ts) - (capture_ts || inference_ts),
          fps: null,
          uplink_kbps: null,
          downlink_kbps: null,
          received_at: Date.now()
        });
      } catch (e) {
  console.error('Inference error:', e && e.stack ? e.stack : e);
  safeSend(ws, { type: 'infer_error', error: e.message || String(e) });
      }
      return;
    }
  });

  ws.on('close', () => {
  console.log('WS connection closed', { role, roomId });
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (role && room[role] === ws) room[role] = null;
  });
});

// TensorFlow.js node + coco-ssd for server-side inference
let tf = null;
let cocoSsd = null;
let model = null;
let canvasModule = null;

async function loadModelOnce() {
  if (model) return model;
  if (!tf) tf = require('@tensorflow/tfjs-node');
  if (!cocoSsd) cocoSsd = require('@tensorflow-models/coco-ssd');
  if (!canvasModule) canvasModule = require('canvas');
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  return model;
}

async function runServerInference(base64Data, mime = 'image/jpeg') {
  await loadModelOnce();
  const { Image, createCanvas, loadImage } = canvasModule;
  const buffer = Buffer.from(base64Data, 'base64');
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const input = tf.browser.fromPixels(canvas);
  const predictions = await model.detect(input);
  input.dispose();
  // Map to normalized detections
  const detections = predictions.map((p) => {
    const [x, y, w, h] = p.bbox;
    return {
      label: p.class,
      score: p.score,
      xmin: Math.max(0, x / img.width),
      ymin: Math.max(0, y / img.height),
      xmax: Math.min(1, (x + w) / img.width),
      ymax: Math.min(1, (y + h) / img.height)
    };
  });
  return detections;
}

server.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (ENABLE_TUNNEL) {
    try {
      const lt = require('localtunnel');
      tunnel = await lt({ port: PORT });
      console.log(`Public URL: ${tunnel.url}`);
    } catch (e) {
      console.log('Localtunnel failed to start:', e.message);
    }
  }
});

process.on('SIGINT', async () => {
  if (tunnel) await tunnel.close();
  process.exit(0);
});


