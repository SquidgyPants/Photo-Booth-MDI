/* Photo Booth server
 * - Serveert de iPad web-app
 * - Slaat fotostrips op en maakt een downloadpagina per foto
 * - Verstuurt de fotostrip per e-mail (SMTP, bv. Gmail)
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const {
  PORT = 3000,
  PUBLIC_URL = `http://localhost:${process.env.PORT || 3000}`,
  BOOTH_KEY = '',
  EVENT_NAME = 'MDI event',
  STRIP_FOOTER = '',
  KEEP_DAYS = '30',
  // E-mail
  SMTP_HOST = '', SMTP_PORT = '465', SMTP_USER = '', SMTP_PASS = '', MAIL_FROM = '',
} = process.env;

const PHOTO_DIR = path.join(__dirname, 'data', 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // achter Cloudflare-tunnel: juiste https-adres herkennen
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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Basisadres voor links in de mail: het adres waarop de iPad de app zelf bereikt.
// Dat adres werkt gegarandeerd; PUBLIC_URL is alleen nodig als de iPad via localhost draait.
function baseUrl(req) {
  const host = req.get('host') || '';
  const isLocal = /^(localhost|127\.|\[::1\])/i.test(host);
  if (isLocal && PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  return `${req.protocol}://${host}`;
}

// ---------- Routes ----------
app.get('/api/config', (req, res) => res.json({ eventName: EVENT_NAME, footer: STRIP_FOOTER }));

app.post('/api/send', requireKey, rateLimit, upload.single('photo'), async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'Geen foto ontvangen' });
    if (req.file.buffer[0] !== 0xff || req.file.buffer[1] !== 0xd8) return res.status(400).json({ error: 'Ongeldig bestand' });
    if (!isEmail(to)) return res.status(400).json({ error: 'Ongeldig e-mailadres' });

    const id = crypto.randomBytes(12).toString('base64url');
    const file = path.join(PHOTO_DIR, `${id}.jpg`);
    await fs.promises.writeFile(file, req.file.buffer);
    const link = `${baseUrl(req)}/p/${id}`;
    await sendEmail(to, file, link);

    console.log(`${new Date().toISOString()} mail verstuurd (${id})`);
    res.json({ ok: true, link });
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
<meta property="og:image" content="${baseUrl(req)}/photos/${id}.jpg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Barlow+Condensed:wght@700&display=swap">
<style>body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 85% 10%,rgba(135,67,136,.45),transparent 55%),radial-gradient(ellipse at 10% 90%,rgba(229,200,12,.15),transparent 55%),#1e0f30;color:#fff;font-family:Barlow,-apple-system,Arial,sans-serif;text-align:center;padding:24px 16px;box-sizing:border-box}
.logo{width:min(320px,70vw);height:auto}
h1{font-family:"Barlow Condensed","Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:1px;color:#e5c80c;margin:8px 0 18px}
img.strip{max-width:100%;max-height:75vh;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6)}
a{display:inline-block;margin-top:20px;background:linear-gradient(135deg,#e5c80c,#e9a31f 60%,#e57a43);color:#1e0f30;font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:14px 32px;border-radius:999px;text-decoration:none;font-size:22px}
p{color:rgba(242,230,245,.7)}</style></head><body>
<img class="logo" src="/logo.png" alt="Minor Dance Industry">
<h1>${escapeHtml(EVENT_NAME)}</h1>
<img class="strip" src="/photos/${id}.jpg" alt="Fotostrip">
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
  console.log(`Mail: ${mailer ? 'aan' : 'TESTMODUS'}`);
});
