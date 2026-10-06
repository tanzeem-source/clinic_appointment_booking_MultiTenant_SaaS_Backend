import { Router } from "express";

const router = Router();

// Dev-only helpers. Not mounted in production (see server.ts).
// Both pages are written without backticks/${} inside so they embed
// safely in a TS template string.

const payTestPage = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dev payment test</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 2rem auto;">
  <h3>Dev payment test — clinic subscription</h3>
  <p>
    <input id="email" placeholder="clinic admin email" size="30">
    <input id="pw" type="password" placeholder="password">
    <button onclick="login()">Login</button>
  </p>
  <p><button onclick="pay()">Pay for subscription</button></p>
  <pre id="out"></pre>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var NL = String.fromCharCode(10);
    function log(x) {
      var text = typeof x === 'string' ? x : JSON.stringify(x, null, 2);
      var out = document.getElementById('out');
      out.textContent = text + NL + NL + out.textContent;
    }
    async function post(url, body) {
      var r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {})
      });
      return { status: r.status, data: await r.json() };
    }
    async function login() {
      log(await post('/api/auth/login', {
        email: document.getElementById('email').value,
        password: document.getElementById('pw').value
      }));
    }
    async function pay() {
      var o = await post('/api/payments/subscription/order');
      if (o.status !== 201) { log(o); return; }
      var rzp = new Razorpay({
        key: o.data.keyId,
        amount: o.data.amount,
        currency: o.data.currency,
        order_id: o.data.orderId,
        name: 'Clinic Booking (test)',
        handler: async function (resp) {
          log(await post('/api/payments/subscription/verify', resp));
        }
      });
      rzp.on('payment.failed', function (r) { log(r.error); });
      rzp.open();
    }
  </script>
</body>
</html>`;

const bookTestPage = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dev booking payment test</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 2rem auto;">
  <h3>Dev payment test — appointment booking</h3>
  <p>
    <input id="email" placeholder="patient email" size="30">
    <input id="pw" type="password" placeholder="password">
    <button onclick="login()">Login</button>
  </p>
  <p>
    <input id="doctorId" placeholder="doctor id" size="38"><br><br>
    <input id="date" placeholder="YYYY-MM-DD" size="12">
    <input id="startTime" placeholder="HH:MM" size="6">
    <button onclick="reserve()">Reserve &amp; Pay</button>
  </p>
  <pre id="out"></pre>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var NL = String.fromCharCode(10);
    function log(x) {
      var text = typeof x === 'string' ? x : JSON.stringify(x, null, 2);
      var out = document.getElementById('out');
      out.textContent = text + NL + NL + out.textContent;
    }
    async function post(url, body) {
      var r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {})
      });
      return { status: r.status, data: await r.json() };
    }
    async function login() {
      log(await post('/api/auth/login', {
        email: document.getElementById('email').value,
        password: document.getElementById('pw').value
      }));
    }
    async function reserve() {
      var r = await post('/api/bookings', {
        doctorId: document.getElementById('doctorId').value,
        date: document.getElementById('date').value,
        startTime: document.getElementById('startTime').value
      });
      log(r);
      if (r.status !== 201) return;

      var rzp = new Razorpay({
        key: r.data.keyId,
        amount: r.data.amount,
        currency: r.data.currency,
        order_id: r.data.orderId,
        name: 'Clinic Booking (test)',
        description: 'Appointment: ' + r.data.date + ' ' + r.data.startTime,
        handler: async function (resp) {
          log(await post('/api/bookings/verify', resp));
        }
      });
      rzp.on('payment.failed', function (f) { log(f.error); });
      rzp.open();
    }
  </script>
</body>
</html>`;

router.get("/pay-test", (_req, res) => {
  res.type("html").send(payTestPage);
});

router.get("/book-test", (_req, res) => {
  res.type("html").send(bookTestPage);
});

export default router;
