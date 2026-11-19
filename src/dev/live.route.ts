import { Router } from "express";

const router = Router();

// Dev-only helper for watching the live streams in a browser. Not mounted in
// production (see server.ts). Written without backticks or dollar-brace inside
// the page so it embeds safely in a TS template string.
const page = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Live updates test</title></head>
<body style="font-family: sans-serif; max-width: 760px; margin: 2rem auto;">
  <h3>Live updates test</h3>
  <p>
    <input id="doc" size="40" placeholder="doctor id">
    <button onclick="watchDoctor()">Watch doctor availability</button>
  </p>
  <p>
    <button onclick="watchInbox()">Watch my notifications</button>
    <button onclick="stopAll()">Stop all</button>
  </p>
  <p style="color:#555; font-size: 13px;">
    The notifications stream uses your login cookie, so log in first (for example on /dev/book-test).
  </p>
  <pre id="out"></pre>
  <script>
    var NL = String.fromCharCode(10);
    var sources = [];

    function log(text) {
      var out = document.getElementById('out');
      out.textContent = new Date().toLocaleTimeString() + '  ' + text + NL + out.textContent;
    }

    function listen(label, url, eventName, withCredentials) {
      var es = new EventSource(url, { withCredentials: withCredentials });
      es.onopen = function () { log(label + ': connected'); };
      es.onerror = function () { log(label + ': connection lost or refused (a lost one is retried automatically)'); };
      es.addEventListener('ready', function (e) { log(label + ': ready ' + e.data); });
      es.addEventListener(eventName, function (e) { log(label + ': ' + eventName + ' ' + e.data); });
      sources.push(es);
    }

    function watchDoctor() {
      var id = document.getElementById('doc').value.trim();
      if (!id) { log('Enter a doctor id first'); return; }
      listen('doctor', '/api/doctors/' + id + '/availability/stream', 'availability', false);
    }

    function watchInbox() {
      listen('inbox', '/api/notifications/stream', 'notification', true);
    }

    function stopAll() {
      sources.forEach(function (s) { s.close(); });
      sources = [];
      log('Stopped all streams');
    }
  </script>
</body>
</html>`;

router.get("/live-test", (_req, res) => {
  res.type("html").send(page);
});

export default router;
