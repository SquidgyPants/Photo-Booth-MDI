/* Photo Booth server
 * - Serveert de iPad web-app
 * - Slaat fotostrips op en maakt een downloadpagina per foto
 * - Verstuurt e-mail (SMTP, bv. Gmail) en sms (via je eigen Android-telefoon met TextBee)
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const {
  PORT = 3000,
  PUBLIC_URL = `http://localhost:${process.env.PORT || 3000}`,
  BOOTH_KEY = '',
  EVENT_NAME = 'MDI event',
  STRIP_FOOTER = '',
  KEEP_DAYS = '30',
  // E-mail
  SMTP_HOST = '', SMTP_PORT = '465', SMTP_USER = '', SMTP_PASS = '', MAIL_FROM = '',
  // Sms via TextBee (Android-telefoon als sms-gateway)
  TEXTBEE_API_KEY = '', TEXTBEE_DEVICE_ID = '',
  TEXTBEE_BASE_URL = 'https://api.textbee.dev/api/v1',
} = process.env;

const PHOTO_DIR = path.join(__dirname, 'data', 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---------- Mail ----------
const mailer = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendEmail(to, file, link) {
  if (!mailer) {
    console.log(`[TESTMODUS] Mail naar ${to} met link ${link}`);
    return;
  }
  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject: `Je foto's van ${EVENT_NAME} 📸`,
    text: `Hoi!\n\nHier zijn je foto's van ${EVENT_NAME}. Je vindt ze in de bijlage, of download ze hier:\n${link}\n\nVeel plezier ermee!`,
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#222">
      <p>Hoi!</p>
      <p>Hier zijn je foto's van <strong>${escapeHtml(EVENT_NAME)}</strong>. Je vindt ze in de bijlage.</p>
      <p><a href="${link}" style="display:inline-block;background:#ff3d6e;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Bekijk &amp; download</a></p>
      <p>Veel plezier ermee!</p></div>`,
    attachments: [{ filename: 'fotostrip.jpg', path: file, contentType: 'image/jpeg' }],
  });
}

// ---------- Sms ----------
async function sendSms(to, link) {
  const message = `Je foto's van ${EVENT_NAME} staan klaar! Download ze hier: ${link}`;
  if (!TEXTBEE_API_KEY || !TEXTBEE_DEVICE_ID) {
    console.log(`[TESTMODUS] Sms naar ${to}: ${message}`);
    return;
  }
  const res = await fetch(`${TEXTBEE_BASE_URL}/gateway/devices/${TEXTBEE_DEVICE_ID}/send-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
    body: JSON.stringify({ recipients: [to], message }),
  });
  if (!res.ok) throw new Error(`Sms-gateway gaf fout ${res.status}: ${await res.text()}`);
}

// ---------- Beveiliging & limieten ----------
function requireKey(req, res, next) {
  if (!BOOTH_KEY || req.get('x-booth-key') === BOOTH_KEY) return next();
  res.status(401).json({ error: 'Booth-sleutel ontbreekt of klopt niet' });
}

const hits = new Map(); // simpele limiet: max 30 verzendingen per 10 minuten
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get('all') || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 30) return res.status(429).json({ error: 'Even te veel verzoeken, probeer zo opnieuw' });
  list.push(now);
  hits.set('all', list);
  next();
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isPhone = (v) => /^\+\d{8,15}$/.test(v);
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Routes ----------
app.get('/api/config', (req, res) => res.json({ eventName: EVENT_NAME, footer: STRIP_FOOTER }));

app.post('/api/send', requireKey, rateLimit, upload.single('photo'), async (req, res) => {
  try {
    const { type, to } = req.body || {};
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'Geen foto ontvangen' });
    if (req.file.buffer[0] !== 0xff || req.file.buffer[1] !== 0xd8) return res.status(400).json({ error: 'Ongeldig bestand' });
    if (type === 'email' && !isEmail(to)) return res.status(400).json({ error: 'Ongeldig e-mailadres' });
    if (type === 'sms' && !isPhone(to)) return res.status(400).json({ error: 'Ongeldig telefoonnummer' });
    if (type !== 'email' && type !== 'sms' && type !== 'qr') return res.status(400).json({ error: 'Onbekend type' });

    const id = crypto.randomBytes(12).toString('base64url');
    const file = path.join(PHOTO_DIR, `${id}.jpg`);
    await fs.promises.writeFile(file, req.file.buffer);
    const link = `${PUBLIC_URL.replace(/\/$/, '')}/p/${id}`;

    let qr;
    if (type === 'email') await sendEmail(to, file, link);
    else if (type === 'sms') await sendSms(to, link);
    else qr = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

    console.log(`${new Date().toISOString()} ${type === 'qr' ? 'qr-code gemaakt' : `${type} verstuurd`} (${id})`);
    res.json({ ok: true, link, qr });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Kon niet versturen, probeer opnieuw' });
  }
});

// Downloadpagina voor gasten
app.get('/p/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{10,40}$/.test(id) || !fs.existsSync(path.join(PHOTO_DIR, `${id}.jpg`))) {
    return res.status(404).send('Deze foto bestaat niet (meer).');
  }
  res.send(`<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Je foto's – ${escapeHtml(EVENT_NAME)}</title>
<meta property="og:image" content="${PUBLIC_URL}/photos/${id}.jpg">
<style>body{margin:0;background:#111;color:#fff;font-family:-apple-system,Arial,sans-serif;text-align:center;padding:24px 16px}
img{max-width:100%;max-height:75vh;border-radius:10px;box-shadow:0 10px 40px #000}
a{display:inline-block;margin-top:20px;background:#ff3d6e;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:18px}
p{color:#aaa}</style></head><body>
<h1>${escapeHtml(EVENT_NAME)} 📸</h1>
<img src="/photos/${id}.jpg" alt="Fotostrip">
<div><a href="/photos/${id}.jpg" download="fotostrip.jpg">Download foto</a></div>
<p>Op iPhone: houd de foto ingedrukt › "Zet in Foto's".</p>
</body></html>`);
});

app.use('/photos', express.static(PHOTO_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// ---------- Opruimen ----------
function cleanup() {
  const maxAge = Number(KEEP_DAYS) * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(PHOTO_DIR)) {
    const p = path.join(PHOTO_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p);
  }
}
cleanup();
setInterval(cleanup, 6 * 3600 * 1000);

app.listen(PORT, () => {
  console.log(`Photo Booth draait op http://localhost:${PORT}`);
  console.log(`Publieke URL: ${PUBLIC_URL}`);
  console.log(`Mail: ${mailer ? 'aan' : 'TESTMODUS'} · Sms: ${TEXTBEE_API_KEY ? 'aan' : 'TESTMODUS'}`);
});
