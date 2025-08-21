## Real-time WebRTC Multi-Object Detection Demo (WASM + Server)

This demo streams live video from a phone (browser) to a viewer (laptop browser) via WebRTC and overlays multi-object detections in near real time.

Two modes:
- wasm: on-device/browser inference using tfjs-wasm + coco-ssd (lite_mobilenet_v2)
- server: server-side inference using Node.js + tfjs-node (coco-ssd); phone snapshots frames over WebSocket with backpressure

### One-command start

```bash
./start.sh            # defaults MODE=wasm
./start.sh --mode server
./start.sh --mode wasm --ngrok   # cross-network via localtunnel
```

Then open `http://localhost:3000` on your laptop.

Windows PowerShell:

```powershell
./start.ps1 -Mode wasm
```
To enable cross-network QR join on Windows:

```powershell
$env:LOCALTUNNEL=1; ./start.ps1 -Mode wasm
```

### Phone join (QR / URL)

1) Click "New Room" to generate `roomId` and click "Show QR".
2) Scan QR with your phone (Chrome on Android, Safari on iOS). Allow camera.
3) You should see live overlays on the laptop.

If the phone cannot reach the laptop (different networks), run with `--ngrok` to get a public URL embedded in the QR.

### Metrics and bench

Run a 30s bench (server mode example):

```bash
./bench/run_bench.sh --duration 30 --mode server
```

This writes `output/metrics.json` with median & P95 E2E latency, processed FPS, and kbps estimates.

### Troubleshooting

- If phone won’t connect: ensure same network or run `./start.sh --ngrok`.
- If overlays are misaligned: confirm timestamps are in ms; coordinates are normalized [0..1].
- If CPU is high: keep 320×240 input, ~12 FPS sampling.
- Use Chrome webrtc-internals for RTP stats.

### Design choices (appendix)

- Minimal WS signaling with `roomId`; viewer and phone exchange SDP/ICE via the server.
- WASM mode: tfjs-wasm for cross-platform low-resource inference; 320×240 downscale; ~12 FPS.
- Server mode: phone JPEG snapshots to server with single in-flight frame (backpressure) → bounded latency.
- Metrics: browser batches samples to `/api/metrics`, server provides snapshots and writes `metrics.json` on bench.

Loom video: [Link](https://www.loom.com/share/3e8d15ccfafd47178a761ca6cc5266ab?sid=41b503c5-df4f-4fc4-979b-22941c8fdd2a).


