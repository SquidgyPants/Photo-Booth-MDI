/* Testen op de iPad zonder eigen server:
 *   npm run test-ipad
 * Start een gratis, tijdelijke https-tunnel (Cloudflare), start de photo booth
 * en toont een QR-code die je met de iPad-camera scant.
 */
require('dotenv').config();
const { spawn } = require('child_process');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || 3000;
const KEY = process.env.BOOTH_KEY || '';

console.log('⏳ Tunnel starten (eerste keer kan een minuutje duren)…');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const tunnel = spawn(npx, ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], {
  shell: process.platform === 'win32',
});

let server = null;
function onOutput(buf) {
  const m = String(buf).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || server) return;
  const url = m[0];
  server = spawn(process.execPath, ['server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_URL: url },
  });
  const appUrl = KEY ? `${url}/?key=${encodeURIComponent(KEY)}` : url;
  setTimeout(() => {
    console.log('\n📱 Scan deze QR-code met de camera van je iPad:\n');
    qrcode.generate(appUrl, { small: true });
    console.log(`\nOf typ in Safari: ${appUrl}`);
    console.log('(Het kan 10–30 seconden duren voordat het adres werkt.)');
    console.log('Stoppen: Ctrl+C\n');
  }, 1500);
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', (code) => {
  if (!server) console.error(`Tunnel kon niet starten (code ${code}). Controleer je internetverbinding.`);
  process.exit(code || 0);
});

function stop() { tunnel.kill(); server?.kill(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
