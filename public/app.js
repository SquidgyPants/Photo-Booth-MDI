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

  async function buildStrip() {
    const W = 1200, pad = 50, photoW = W - pad * 2, photoH = Math.round(photoW * 3 / 4);
    const header = 150, footer = 120;
    const H = header + SHOTS * photoH + (SHOTS - 1) * pad + footer + pad;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 64px -apple-system, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(config.eventName, W / 2, header / 2 + 10);

    shots.forEach((frame, i) => {
      const y = header + i * (photoH + pad);
      coverDraw(ctx, frame, pad, y, photoW, photoH);
    });

    const date = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    ctx.fillStyle = '#666';
    ctx.font = '500 44px -apple-system, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(config.footer || date, W / 2, H - footer / 2 - pad / 2);

    stripDataUrl = c.toDataURL('image/jpeg', 0.88);
    stripBlob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
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
      $('#done-text').textContent = 'Open de camera op je telefoon en richt hem op de code om je foto te downloaden.';
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
