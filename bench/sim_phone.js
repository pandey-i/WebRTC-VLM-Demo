// Simple simulator that connects as a 'phone' and sends infer_frame messages
// Usage: node bench/sim_phone.js --room <roomId> --frames 30 --interval 200

const WebSocket = require('ws');
const argv = require('minimist')(process.argv.slice(2));
const room = argv.room || argv.r;
const frames = parseInt(argv.frames || argv.f || '30', 10);
const interval = parseInt(argv.interval || argv.i || '200', 10);
if (!room) { console.error('Missing --room <roomId>'); process.exit(1); }

// tiny 16x16 JPEG base64 (very small placeholder)
const base64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUSEhIVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lICYtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAKAAoAMBIgACEQEDEQH/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAJf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ANf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ANf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ANf/2Q==';

const url = `ws://localhost:3000/ws`;
const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('WS open, joining room', room);
  ws.send(JSON.stringify({ type: 'join', role: 'phone', roomId: room }));
  let sent = 0;
  const t = setInterval(() => {
    if (sent >= frames) { clearInterval(t); console.log('Done sending frames'); return; }
    const frame_id = Math.random().toString(36).slice(2);
    const capture_ts = Date.now();
    const msg = { type: 'infer_frame', frame_id, capture_ts, recv_ts: Date.now(), mime: 'image/jpeg', data: base64 };
    try { ws.send(JSON.stringify(msg)); console.log('sent frame', frame_id); } catch (e) { console.error('send failed', e.message); }
    sent++;
  }, interval);
});
ws.on('message', (data) => {
  try { const m = JSON.parse(data.toString()); console.log('recv', m.type || m);
  } catch (e) { console.log('recv non-json'); }
});
ws.on('error', (e) => console.error('ws error', e.message));
ws.on('close', () => console.log('ws closed'));
