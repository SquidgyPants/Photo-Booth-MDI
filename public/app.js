/* Photo Booth – iPad web-app
 * Flow: start → 3x (5s aftellen → foto) → fotostrip → mail/sms → klaar
 */
(() => {
  'use strict';

  // ---------- Instellingen ----------
  const SHOTS = 3;              // aantal foto's per sessie
  const COUNTDOWN = 4;          // seconden tussen foto's
  const IDLE_RESET_MS = 90_000; // terug naar start bij inactiviteit
  const DONE_RESET_MS = 15_000; // na versturen automatisch terug
  const QR_RESET_MS = 60_000;   // QR-code blijft langer in beeld zodat iedereen kan scannen

  // Booth-sleutel: open de app één keer met ?key=JOUWSLEUTEL, daarna wordt hij onthouden.
  const params = new URLSearchParams(location.search);
  if (params.get('key')) store('boothKey', params.get('key'));
  const BOOTH_KEY = store('boothKey') || '';

  // ---------- Elementen ----------
  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const flashEl = $('#flash');
  const screens = {
    start: $('#screen-start'),
    capture: $('#screen-capture'),
    review: $('#screen-review'),
    input: $('#screen-input'),
    done: $('#screen-done'),
  };

  let config = { eventName: 'Photo Booth', footer: '' };
  let flashOn = store('flash') !== 'off';
  let shots = [];
  let stripBlob = null;
  let stripDataUrl = null;
  let sendType = 'email';
  let busy = false;
  let idleTimer = null;
  let doneTimer = null;
  let audioCtx = null;

  // ---------- Hulpjes ----------
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (_) { return null; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    resetIdle();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    const current = Object.keys(screens).find((k) => screens[k].classList.contains('active'));
    if (current && current !== 'start' && current !== 'capture') {
      idleTimer = setTimeout(newSession, IDLE_RESET_MS);
    }
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

  function beep(freq = 880, dur = 0.08, vol = 0.15) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g).connect(audioCtx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch (_) { /* geluid is optioneel */ }
  }

  // ---------- Camera ----------
  async function startCamera() {
    const err = $('#camera-error');
    if (!navigator.mediaDevices?.getUserMedia) {
      err.textContent = 'Camera niet beschikbaar. Open de app via https:// (of localhost).';
      err.classList.remove('hidden');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      err.classList.add('hidden');
    } catch (e) {
      err.textContent = 'Geen toegang tot de camera. Sta cameratoegang toe in Instellingen › Safari › Camera en herlaad de app.';
      err.classList.remove('hidden');
      console.error(e);
    }
  }

  // Als de iPad uit slaap komt kan de stream stoppen: opnieuw starten.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (!track || track.readyState === 'ended') startCamera();
    }
  });

  function grabFrame() {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 960;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    // Spiegelen zodat de foto overeenkomt met wat je in beeld zag
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    return c;
  }

  // ---------- Flits ----------
  async function flashAndCapture() {
    if (flashOn) {
      flashEl.classList.remove('fade');
      flashEl.classList.add('on');      // scherm wordt wit = licht op gezichten
      await sleep(180);                 // camera laten bijstellen op het extra licht
      const frame = grabFrame();
      beep(1400, 0.12, 0.2);
      flashEl.classList.add('fade');
      flashEl.classList.remove('on');
      return frame;
    }
    beep(1400, 0.12, 0.2);
    return grabFrame();
  }

  // ---------- Sessie ----------
  async function runSession() {
    if (busy) return;
    if (!video.srcObject) { await startCamera(); if (!video.srcObject) return; }
    busy = true;
    shots = [];
    $('#thumbs').innerHTML = '';
    show('capture');

    const cd = $('#countdown');
    for (let i = 0; i < SHOTS; i++) {
      $('#shot-label').textContent = `Foto ${i + 1} van ${SHOTS}`;
      for (let s = COUNTDOWN; s >= 1; s--) {
        cd.textContent = s;
        cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick');
        beep(s === 1 ? 1100 : 760);
        await sleep(1000);
      }
      cd.textContent = '';
      const frame = await flashAndCapture();
      shots.push(frame);
      const t = document.createElement('img');
      t.src = frame.toDataURL('image/jpeg', 0.6);
      $('#thumbs').appendChild(t);
      await sleep(700);
    }

    await buildStrip();
    $('#strip-preview').src = stripDataUrl;
    busy = false;
    show('review');
  }

  // ---------- Fotostrip ----------
  function coverDraw(ctx, img, x, y, w, h) {
    const r = Math.max(w / img.width, h / img.height);
    const sw = w / r, sh = h / r;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
  }

  // Huisstijl Minor Dance Industry (kleuren uit het logo)
  const BRAND = {
    night: '#1e0f30',
    deep: '#2a1640',
    purple: '#472869',
    plum: '#874388',
    yellow: '#e5c80c',
    orange: '#e57a43',
    lavender: '#f2e6f5',
  };
  const DISPLAY_FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

  // Logo één keer inladen voor de fotostrip
  const logoImg = new Image();
  const logoReady = new Promise((resolve) => {
    logoImg.onload = () => resolve(true);
    logoImg.onerror = () => resolve(false);
  });
  logoImg.src = 'logo.png';

  async function fontsReady() {
    if (!document.fonts?.load) return;
    await Promise.race([
      Promise.all([
        document.fonts.load(`700 64px ${DISPLAY_FONT}`),
        document.fonts.load(`500 40px ${DISPLAY_FONT}`),
      ]).catch(() => {}),
      sleep(1500),
    ]);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function glow(ctx, x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  async function buildStrip() {
    const hasLogo = await logoReady;
    await fontsReady();

    const W = 1200, pad = 60, gap = 40, frame = 8;
    const photoW = W - pad * 2, photoH = Math.round(photoW * 3 / 4);
    const logoW = 760;
    const logoH = hasLogo ? Math.round(logoW * logoImg.height / logoImg.width) : 200;
    const header = logoH + 100;
    const footer = 230;
    const H = header + SHOTS * photoH + (SHOTS - 1) * gap + footer;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Achtergrond: diep paars met gloed in logokleuren
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, BRAND.deep);
    bg.addColorStop(0.5, BRAND.night);
    bg.addColorStop(1, BRAND.deep);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    glow(ctx, W * 0.85, header * 0.4, 700, 'rgba(135, 67, 136, 0.55)');
    glow(ctx, W * 0.1, H * 0.45, 650, 'rgba(229, 200, 12, 0.16)');
    glow(ctx, W * 0.9, H * 0.7, 600, 'rgba(135, 67, 136, 0.4)');
    glow(ctx, W * 0.2, H - 120, 600, 'rgba(229, 122, 67, 0.25)');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Logo bovenaan
    if (hasLogo) {
      ctx.drawImage(logoImg, (W - logoW) / 2, 50, logoW, logoH);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = `700 90px ${DISPLAY_FONT}`;
      ctx.fillText('MINOR DANCE INDUSTRY', W / 2, header / 2);
    }

    // Foto's met lavendel kader
    shots.forEach((img, i) => {
      const x = pad, y = header + i * (photoH + gap);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 10;
      ctx.fillStyle = BRAND.lavender;
      roundRect(ctx, x - frame, y - frame, photoW + frame * 2, photoH + frame * 2, 22);
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundRect(ctx, x, y, photoW, photoH, 14);
      ctx.clip();
      coverDraw(ctx, img, x, y, photoW, photoH);
      ctx.restore();
    });

    // Voettekst: lijn in logokleuren, eventnaam en datum
    const fy = H - footer;
    const line = ctx.createLinearGradient(pad, 0, W - pad, 0);
    line.addColorStop(0, BRAND.plum);
    line.addColorStop(0.35, BRAND.yellow);
    line.addColorStop(0.65, BRAND.orange);
    line.addColorStop(1, BRAND.plum);
    ctx.fillStyle = line;
    roundRect(ctx, W / 2 - 200, fy + 52, 400, 6, 3);
    ctx.fill();

    ctx.fillStyle = BRAND.yellow;
    ctx.font = `700 76px ${DISPLAY_FONT}`;
    ctx.fillText(String(config.eventName).toUpperCase(), W / 2, fy + 120, W - pad * 2);

    const date = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    ctx.fillStyle = BRAND.lavender;
    ctx.font = `500 40px ${DISPLAY_FONT}`;
    ctx.fillText((config.footer || date).toUpperCase(), W / 2, fy + 180, W - pad * 2);

    stripDataUrl = c.toDataURL('image/jpeg', 0.9);
    stripBlob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }

  // ---------- Versturen ----------
  function openInput(type) {
    sendType = type;
    const input = $('#input-to');
    input.value = '';
    $('#input-error').classList.add('hidden');
    if (type === 'email') {
      $('#input-title').textContent = 'Je e-mailadres';
      input.type = 'email';
      input.inputMode = 'email';
      input.placeholder = 'naam@voorbeeld.nl';
      $('#input-hint').textContent = 'Je ontvangt de fotostrip als bijlage.';
    } else {
      $('#input-title').textContent = 'Je mobiele nummer';
      input.type = 'tel';
      input.inputMode = 'tel';
      input.placeholder = '06 12345678';
      $('#input-hint').textContent = 'Je ontvangt een sms met een link om je foto\'s te downloaden.';
    }
    show('input');
    setTimeout(() => input.focus(), 250);
  }

  function normalizePhone(raw) {
    let p = raw.replace(/[\s\-().]/g, '');
    if (p.startsWith('00')) p = '+' + p.slice(2);
    if (/^06\d{8}$/.test(p)) p = '+31' + p.slice(1);       // Nederlands 06-nummer
    if (/^6\d{8}$/.test(p)) p = '+31' + p;
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }

  function validate(value) {
    if (sendType === 'email') {
      const v = value.trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
    }
    return normalizePhone(value);
  }

  // Uploadt de fotostrip naar de server; geeft { link, qr } terug.
  async function uploadStrip(type, to) {
    const fd = new FormData();
    fd.append('type', type);
    if (to) fd.append('to', to);
    fd.append('photo', stripBlob, 'fotostrip.jpg');
    const res = await fetch('api/send', {
      method: 'POST',
      headers: { 'x-booth-key': BOOTH_KEY },
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
    return data;
  }

  // Delen vanaf de iPad (AirDrop, WhatsApp, Berichten…) – werkt zonder server of internet.
  function shareFile() {
    return stripBlob && new File([stripBlob], 'fotostrip-minor-dance-industry.jpg', { type: 'image/jpeg' });
  }
  function canShareFiles() {
    try {
      const test = new File([new Blob()], 'test.jpg', { type: 'image/jpeg' });
      return !!navigator.canShare?.({ files: [test] });
    } catch (_) { return false; }
  }
  async function shareStrip() {
    const file = shareFile();
    if (!file) return;
    try {
      // Geen await vóór share(): Safari eist dat dit direct na de tik gebeurt.
      await navigator.share({ files: [file], title: config.eventName });
    } catch (err) {
      if (err.name !== 'AbortError') alert('Delen lukt niet: ' + err.message);
    }
  }

  // QR-code: foto uploaden en een scanbare downloadlink tonen.
  async function showQr() {
    if (busy) return;
    busy = true;
    const btn = $('#btn-qr');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Bezig…';
    try {
      const data = await uploadStrip('qr');
      if (!data.qr) throw new Error('Geen QR-code ontvangen');
      $('#qr-img').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.qr);
      $('#qr-img').classList.remove('hidden');
      $('#done-icon').textContent = '📲';
      $('#done-title').textContent = 'Scan de QR-code';
      $('#done-text').textContent = 'Richt de camera van je telefoon op de code: je foto wordt direct gedownload.';
      show('done');
      clearTimeout(doneTimer);
      doneTimer = setTimeout(newSession, QR_RESET_MS);
    } catch (err) {
      alert('QR-code maken mislukt: ' + err.message);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function send(e) {
    e.preventDefault();
    const errEl = $('#input-error');
    const to = validate($('#input-to').value);
    if (!to) {
      errEl.textContent = sendType === 'email' ? 'Dit e-mailadres lijkt niet te kloppen.' : 'Dit telefoonnummer lijkt niet te kloppen.';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = $('#btn-send');
    btn.disabled = true;
    btn.textContent = 'Bezig…';
    errEl.classList.add('hidden');

    try {
      await uploadStrip(sendType, to);

      $('#done-icon').textContent = '✅';
      $('#done-title').textContent = 'Verstuurd!';
      $('#done-text').textContent = sendType === 'email'
        ? `Je foto's zijn onderweg naar ${to}. Check ook je spam-map.`
        : `Je ontvangt zo een sms op ${to}.`;
      $('#qr-img').classList.add('hidden');
      show('done');
      clearTimeout(doneTimer);
      doneTimer = setTimeout(newSession, DONE_RESET_MS);
    } catch (err) {
      errEl.textContent = 'Versturen mislukt: ' + err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Versturen';
    }
  }

  function newSession() {
    clearTimeout(doneTimer);
    shots = []; stripBlob = null; stripDataUrl = null;
    document.activeElement?.blur?.();
    show('start');
  }

  // ---------- Events ----------
  function renderFlash() {
    $('#btn-flash').setAttribute('aria-pressed', String(flashOn));
    $('#flash-state').textContent = flashOn ? 'aan' : 'uit';
  }
  $('#btn-flash').addEventListener('click', () => {
    flashOn = !flashOn;
    store('flash', flashOn ? 'on' : 'off');
    renderFlash();
  });
  $('#btn-start').addEventListener('click', runSession);
  $('#btn-retake').addEventListener('click', runSession);
  $('#btn-done').addEventListener('click', newSession);
  $('#btn-new').addEventListener('click', newSession);
  $('#btn-other').addEventListener('click', () => { clearTimeout(doneTimer); show('review'); });
  $('#btn-back').addEventListener('click', () => show('review'));
  document.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', () => openInput(b.dataset.send)));
  $('#btn-qr').addEventListener('click', showQr);
  $('#btn-share').addEventListener('click', shareStrip);
  $('#btn-share').classList.toggle('hidden', !canShareFiles());
  $('#send-form').addEventListener('submit', send);

  // Voorkom zoomen/scrollen met gebaren
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!e.target.closest('input')) e.preventDefault(); }, { passive: false });

  // ---------- Init ----------
  (async () => {
    renderFlash();
    try {
      const r = await fetch('api/config');
      if (r.ok) config = { ...config, ...(await r.json()) };
    } catch (_) { /* offline: standaardwaarden */ }
    $('#event-name').textContent = config.eventName;
    document.title = config.eventName;
    startCamera();
  })();
})();
