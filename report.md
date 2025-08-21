Demo report
===========

One-line goal
------------
Real-time multi-object detection on live phone video streamed via WebRTC; server performs inference and returns bounding boxes to the viewer for overlay.

Bench summary (30s, server mode)
--------------------------------
- mode: server
- duration_s: 30
- samples: 99
- e2e_latency_ms_median: 5547 ms
- e2e_latency_ms_p95: 5965 ms
- processed_fps_median: 1 FPS
- server_latency_ms_median: 5490 ms

Notes on results
----------------
- The server is performing inference (server logs show many "Inference done" messages). The measured end-to-end median (~5.5s) is high and processed FPS is low, indicating either slow end-to-end round-trips, queuing/backpressure behavior, or measurement cadence differences between client postings and server metrics aggregation.
- `uplink_kbps` and `downlink_kbps` were 0 in the snapshot, which typically means the browser-side network stats were not available or not reported during the bench window; re-run with an active viewer (and open DevTools) to produce richer network samples.

How the demo was recorded
-------------------------
Loom link provided by author: https://www.loom.com/share/3e8d15ccfafd47178a761ca6cc5266ab

Suggested 1-minute recording script (what the video should highlight)
- Show starting the server (`./start.ps1` or `npm start`) and the generated room id.
- Show phone joining (or scrcpy mirroring) and the viewer receiving the stream.
- Point out the overlay canvas and demonstrate a few frames where boxes appear.
- Run the 30s bench while both phone + viewer are active (so latency samples get posted) and open `output/metrics.json` to show final numbers.
- One-sentence tradeoffs: "Server inference gives central control and easier model updates, but adds measurable network and queueing latency — trade accuracy/throughput by reducing frame rate, downscaling frames, or moving inference to-device."

Next recommended steps
----------------------
1. Re-run the 30s bench while the viewer and phone are both active and posting metrics (open DevTools on the viewer to ensure `/api/metrics` POSTs occur). This will populate uplink/downlink and give more reliable FPS/e2e numbers.
2. If overlays aren't visible on a viewer, open DevTools Console and check for these debug logs (client change added):
   - "Received infer_result (ws) <frame_id> detections= N"
   - "Drew overlay for frame <frame_id> detections= N"
3. Optionally add a small replay helper page to inject a synthetic `infer_result` into the viewer so you can verify drawing without a live phone. If you'd like, I can add this now.

Files of interest
-----------------
- `server/index.js` — signaling, server-mode inference, bench endpoint that writes `output/metrics.json`.
- `frontend/public/main.js` — viewer/phone UI, overlay drawing and added debug logs.
- `bench/run_bench.ps1` — runs the bench on Windows and writes the snapshot to `output/metrics.json`.
- `output/metrics.json` — the most recent bench snapshot (included in the repo output folder).

If you want, I can (pick one):
- add the replay helper page that emits a canned `infer_result` to the viewer (fast, low-risk), or
- add per-frame timestamp instrumentation on the server to record capture_ts/recv_ts/inference_ts/send_ts for fuller breakdowns, or
- prepare an OBS/recording scene for a polished Loom capture.

— End of report
