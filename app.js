'use strict';
/*
 * ETWOW Tuning - Web Bluetooth. Implements the BLE protocol proven from the com.etwowconnect app.
 * Proven (app_side, code-verified): 3 model profiles share ONE protocol and differ only in UUIDs -
 *   GT SE / BOOSTER V = service FFE0, notify+write FFE1; GT TWO MOTOR = service FF00, notify FF01, write FF02.
 * Command frame builder: 5 bytes [0]=0x55 [1]=cmd [2]=0x05 [3]=arg
 *   [4]=(0x55+cmd+0x05+arg)&0xFF, written withoutResponse to the transfer characteristic.
 * Opcodes (cmd byte): actionOff=0 actionOn=1 mainSpeedLimit=2 zeroStart=3 lockScooter=5 light=6 changeUnit=8
 *   resetKm=9. Speed-limit args: Max=0, 6=1, 20=2, 25=3 (a discrete 4-step register, NOT a free km/h value).
 * Telemetry: notifications are exactly 4 bytes (len==4 enforced); byte[0]=type,
 *   readInt16LE(bytes 1..2); type1->/10, type2->raw, type3->8-bit status bitfield + numeric, type4->/10.
 * Type-3 status bits are code-proven to read back four live states: the parser (Le,
 *   rn-decompiled.js:385220-385258) calls the SAME React state setters the command handlers write -
 *   bit[0]=zero-start, bit[2]=lock, bit[3]=light, bits[5..7]=speed-limit step (0=Max,1=6,2=20,3=25).
 * No auth: plaintext 0x55 frames, no PIN/pairing/handshake - any client that knows the frame can read + write.
 * Device_side UNKNOWN (needs on-device/HCI): the real unit/semantics of the type1/2/4 numeric values,
 *   whether the firmware enforces speed-limit/lock, and the changeUnit arg meaning. Writes are gated, the
 *   risky ones confirm-boxed; an echo only means "accepted".
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v1';

// --------------------------- UUIDs (Web Bluetooth wants full lowercase 128-bit form) ---------------------------
const uuid16 = (h) => '0000' + String(h).toLowerCase() + '-0000-1000-8000-00805f9b34fb';
// The 3 connectable profiles proven from the app. All share one frame + opcode
// table; they differ ONLY in these UUIDs. GT SE and BOOSTER V are byte-identical (same FFE0/FFE1).
const MODELS = [
  { name: 'E-TWOW',   label: 'GT SE',        service: 'FFE0', notify: 'FFE1', write: 'FFE1' },
  { name: 'E-TWOWv2', label: 'GT TWO MOTOR', service: 'FF00', notify: 'FF01', write: 'FF02' },
  { name: 'boosterv', label: 'BOOSTER V',    service: 'FFE0', notify: 'FFE1', write: 'FFE1' }
];
const CANDIDATE_SERVICES = [uuid16('FFE0'), uuid16('FF00')];   // the two distinct service UUIDs across the 3 models

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u || '').slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'etwow_theme', PUBLOG: 'etwow_publog', DEV: 'etwow_device' };

let dev = null, server = null, notifyCh = null, writeCh = null, activeModel = null, busy = false;
let connected = false;
let pendingDeepAction = null;   // 'unlock' | 'lock' from a ?do= shortcut

// live device state, rebuilt from the 4-byte push frames (tiles read from this)
const S = {
  val1: null,       // type 1 int16/10 (unit device_side unknown)
  val2: null,       // type 2 int16 raw (unit device_side unknown)
  val4: null,       // type 4 int16/10 (unit device_side unknown)
  statusBits: null, // type 3 int16 as an 8-bit binary status string
  statusNum: null,  // type 3 numeric value
  // decoded type-3 flags (proven mapping, see parseFrame)
  flagZeroStart: null, flagLock: null, flagLight: null, speedStep: null
};
function resetState() { for (const k of Object.keys(S)) S[k] = null; }

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (b) => logLine('log-tx', '>>> ' + short(writeCh && writeCh.uuid) + ' | ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + short(notifyCh && notifyCh.uuid) + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-etwow-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== etwow-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from com.etwowconnect; self-test below runs at load)
// =========================================================================================
// TX frame (builder proven from the app): 5 bytes, written base64/withoutResponse in the app,
// here as a raw ArrayBuffer over Web Bluetooth:
//   [0]=0x55 header | [1]=cmd | [2]=0x05 const | [3]=arg | [4]=checksum=(0x55+cmd+0x05+arg)&0xFF
// The &0xFF is runtime-implicit in the app (Node Buffer byte-write truncates to 8 bits); made explicit here.
const OP = { actionOff: 0, actionOn: 1, mainSpeedLimit: 2, zeroStart: 3, lockScooter: 5, light: 6, changeUnit: 8, resetKm: 9 };
// mainSpeedLimit args (byte[3]): a DISCRETE 4-step register, not a free km/h value.
const SPEED_ARG = { max: 0, kmh6: 1, kmh20: 2, kmh25: 3 };
// resetKm args (byte[3]): resetTrip=0, resetOddo=1 (proven from the app).
const RESET_ARG = { trip: 0, odo: 1 };

function buildFrame(cmd, arg) {
  cmd &= 0xff; arg &= 0xff;
  const cksum = (0x55 + cmd + 0x05 + arg) & 0xff;
  return [0x55, cmd, 0x05, arg, cksum];
}
// strict TX validator mirroring the builder (header 0x55, const 0x05 at [2], additive checksum at [4])
function validFrame(f) {
  if (!f || f.length !== 5 || (f[0] & 0xff) !== 0x55 || (f[2] & 0xff) !== 0x05) return false;
  return (((0x55 + (f[1] & 0xff) + 0x05 + (f[3] & 0xff)) & 0xff) === (f[4] & 0xff));
}

// RX telemetry parser (proven from the app). Notifications are EXACTLY 4 bytes; byte[0]=type.
const s16le = (b, i) => { const v = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8); return v >= 0x8000 ? v - 0x10000 : v; };
const TYPE_LABEL = { 1: 'type 1 (x0.1)', 2: 'type 2 (raw)', 3: 'type 3 (status)', 4: 'type 4 (x0.1)' };
function parseFrame(f) {
  const type = f[0] & 0xff;
  const raw = s16le(f, 1);
  if (type === 1) S.val1 = +(raw / 10).toFixed(1);
  else if (type === 2) S.val2 = raw;
  else if (type === 3) {
    S.statusNum = (raw >>> 0); S.statusBits = (raw >>> 0).toString(2).padStart(8, '0');
    // Flags proven from the app's Le parser (rn-decompiled.js:385224-385258): the type-3 bits are
    // fed to the SAME state setters the light/lock/zero-start/speed command handlers write, so the
    // MSB-first 8-char string maps bit[0]=zero-start, bit[2]=lock, bit[3]=light, bits[5..7]=speed step.
    const bs = S.statusBits;
    S.flagZeroStart = bs[0] === '1';
    S.flagLock = bs[2] === '1';
    S.flagLight = bs[3] === '1';
    S.speedStep = 4 * (+bs[5]) + 2 * (+bs[6]) + (+bs[7]);
  }
  else if (type === 4) S.val4 = +(raw / 10).toFixed(1);
}
// readback speed step -> the four wired labels (0=Max,1=6,2=20,3=25; proven from the speed command args)
function speedStepText(s) { if (s == null) return null; const m = { 0: 'Max', 1: '6 km/h', 2: '20 km/h', 3: '25 km/h' }; return m[s] != null ? m[s] : String(s); }

// load-time self-test: builder must match hand-computed vectors, and every built frame must re-validate.
// Vectors (checksum = (0x55 + cmd + 0x05 + arg) & 0xFF):
//   speed Max:  55 02 05 00 -> ck 0x5C ; lock on: 55 05 05 01 -> 0x60 ; light on: 55 06 05 01 -> 0x61
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  const t1 = eq(buildFrame(OP.mainSpeedLimit, SPEED_ARG.max), [0x55, 0x02, 0x05, 0x00, 0x5c]);
  const t2 = eq(buildFrame(OP.lockScooter, 1), [0x55, 0x05, 0x05, 0x01, 0x60]);
  const t3 = eq(buildFrame(OP.light, 1), [0x55, 0x06, 0x05, 0x01, 0x61]);
  return t1 && t2 && t3 && validFrame(buildFrame(OP.mainSpeedLimit, SPEED_ARG.kmh20)) && validFrame(buildFrame(OP.changeUnit, 0));
})();

// --------------------------- tiles ---------------------------
const TILE_IDS = ['t-val1', 't-val2', 't-val4', 't-statusbits', 't-statusnum', 't-flag-zero', 't-flag-lock', 't-flag-light', 't-speedstep'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { TILE_IDS.forEach(id => setTile(id, null)); }
function refreshTiles() {
  setTile('t-val1', S.val1 == null ? null : String(S.val1));
  setTile('t-val2', S.val2 == null ? null : String(S.val2));
  setTile('t-val4', S.val4 == null ? null : String(S.val4));
  setTile('t-statusbits', S.statusBits == null ? null : S.statusBits);
  setTile('t-statusnum', S.statusNum == null ? null : String(S.statusNum));
  const onOff = (v) => v == null ? null : (v ? t('valOn') : t('valOff'));
  setTile('t-flag-zero', onOff(S.flagZeroStart));
  setTile('t-flag-lock', onOff(S.flagLock));
  setTile('t-flag-light', onOff(S.flagLight));
  setTile('t-speedstep', speedStepText(S.speedStep));
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  refreshTiles(); updateShortcuts();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // cards hidden until connected (header/intro/connect/log stay visible)
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- connect (acceptAll + GATT service is the real gate; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: CANDIDATE_SERVICES.map(s => ({ services: [s] })), optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    try { localStorage.setItem(LS.DEV, dev.id); } catch (e) {}
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'ETWOW') + '\x01' + ' (' + activeModel.label + ')'; }
    logSys('connected as ' + activeModel.label + ', notify ' + short(notifyCh.uuid) + ', write ' + short(writeCh.uuid));
    await maybeRunDeepAction();
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const found = await resolveModel(server);
      if (!found) { setStatus('no-service'); throw new Error('no known E-TWOW service (FFE0 / FF00) found'); }
      activeModel = found.model;
      notifyCh = await found.svc.getCharacteristic(uuid16(found.model.notify));
      writeCh = (found.model.notify === found.model.write) ? notifyCh : await found.svc.getCharacteristic(uuid16(found.model.write));
      await notifyCh.startNotifications();
      notifyCh.addEventListener('characteristicvaluechanged', onCharValue);
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
// FF00 (GT TWO MOTOR) is distinctive; FFE0 is shared by GT SE and BOOSTER V (byte-identical profile).
async function resolveModel(srv) {
  const twoMotor = MODELS.find(m => m.service === 'FF00');
  const ffe0 = MODELS.find(m => m.service === 'FFE0');
  for (const model of [twoMotor, ffe0]) {
    try { const svc = await srv.getPrimaryService(uuid16(model.service)); return { model, svc }; } catch (_) {}
  }
  return null;
}
function onDisconnected() {
  connected = false; notifyCh = null; writeCh = null; activeModel = null;
  setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify + ACK ---------------------------
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(b);
  // the app enforces exactly 4-byte telemetry frames and bails otherwise
  if (b.length !== 4) { logDiag('non-4-byte frame ignored (app enforces len==4): ' + hex(b)); return; }
  handleFrame(b);
}
function handleFrame(f) {
  const type = f[0] & 0xff;
  parseFrame(f);
  resolveAck('type:' + type);
  refreshTiles();
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeFrame(bytes) {
  const arr = Uint8Array.from(bytes);
  // the app writes withoutResponse (writeCharacteristicWithoutResponseForDevice); fall back if the stack differs.
  if (writeCh.properties.writeWithoutResponse) return writeCh.writeValueWithoutResponse(arr);
  if (writeCh.properties.write) return writeCh.writeValueWithResponse(arr);
  return writeCh.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !writeCh) { logErr(t('errNotConnected')); return; }
  logTx(bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeFrame(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes on the single characteristic (eg guard mutex; vr/ap/vmax omit it)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- commands (all via the one 5-byte Fe frame) ---------------------------
// Status flags (lock/light/zero-start) are reflected in the type-3 status frame, so those arm a 'type:3' ack.
// Speed-limit and unit have no proven telemetry read-back (device_side), so they log "sent" with no ack claim.
async function setCmd(cmd, arg, label, ackKey) { await transmit(buildFrame(cmd, arg), label, ackKey); }
async function setSpeedStep(arg, label, risky) {
  if (risky && !await confirmRisky(t('warnSpeedMax'))) return;
  await setCmd(OP.mainSpeedLimit, arg, label);
}

// --------------------------- settings (static rows in more-card; one 5-byte Fe frame per Senden) ---------------------------
// The scooter has no telemetry read-back for these toggles, so each row is a command selector: it sends the
// chosen value when the user taps Senden. Light/lock/zero-start are reflected in the type-3 status frame and
// arm a 'type:3' ack; unit has no proven read-back and only logs "sent".
function selVal(id) { return parseInt(($(id) || {}).value, 10) || 0; }
async function doLight() { await setCmd(OP.light, selVal('sel-light') ? 1 : 0, t('setLight'), 'type:3'); }
async function doUnit() { await setCmd(OP.changeUnit, selVal('sel-unit') ? 1 : 0, t('setUnit')); }
async function doZeroStart() { await setCmd(OP.zeroStart, selVal('sel-zerostart') ? 1 : 0, t('setZeroStart'), 'type:3'); }

// lock (immobilizer, confirm-gated) and odometer reset (odo reset is destructive, confirm-gated).
async function doLock(on) { if (!await confirmRisky(t(on ? 'warnLock' : 'warnUnlock'))) return; await setCmd(OP.lockScooter, on ? 1 : 0, t(on ? 'btnImmobLock' : 'btnImmobUnlock'), 'type:3'); }
async function doResetKm() {
  const odo = selVal('sel-resetkm') === 1;   // 0 = trip (RESET_ARG.trip), 1 = total odometer (RESET_ARG.odo)
  if (odo && !await confirmRisky(t('warnOdoReset'))) return;
  await setCmd(OP.resetKm, odo ? RESET_ARG.odo : RESET_ARG.trip, t('setResetKm'));
}

// --------------------------- expert tier (raw verbatim + free builder; details is the gate) ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');   // strip spaces/punctuation
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));   // pairs; drop a dangling nibble
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  await transmit(bytes, t('rawLabel'));   // sent verbatim, no header/checksum added
}
async function cmdFree() {
  const op = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(op)) { logErr(t('errBadOp')); return; }
  const arg = parseInt(($('free-arg') || {}).value, 16) || 0;
  await transmit(buildFrame(op, arg), t('freeLabel') + ' 0x' + (op & 0xff).toString(16));   // proper 0x55 frame + checksum
}

// --------------------------- shortcut deep-link (?do=unlock|lock) ---------------------------
function parseDeepLink() {
  const q = new URLSearchParams(location.search); let a = q.get('do');
  if (!a && location.hash) { const m = location.hash.match(/do=([a-z]+)/i); if (m) a = m[1]; }
  if (!a) return;
  a = a.toLowerCase();
  if (a === 'unlock' || a === 'fast') pendingDeepAction = 'unlock';
  else if (a === 'lock' || a === 'slow') pendingDeepAction = 'lock';
}
async function maybeRunDeepAction() {
  if (!pendingDeepAction) return;
  const act = pendingDeepAction; pendingDeepAction = null;
  if (act === 'unlock') await guard(() => setSpeedStep(SPEED_ARG.max, t('scUnlock'), true));
  else await guard(() => setSpeedStep(SPEED_ARG.kmh20, t('scLock'), false));
}
async function tryAutoReconnect() {
  if (!pendingDeepAction || !navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const list = await navigator.bluetooth.getDevices(); let saved = null; try { saved = localStorage.getItem(LS.DEV); } catch (e) {}
    const d = list.find(x => x.id === saved) || list[0]; if (!d) return;
    dev = d; dev.addEventListener('gattserverdisconnected', onDisconnected);
    setStatus('linking'); await connectGatt(); setStatus('connected'); connected = true; setControlsEnabled(true);
    logSys('auto-reconnect (shortcut)'); await maybeRunDeepAction();
  } catch (e) { logDiag('auto-reconnect skipped: ' + (e && e.message ? e.message : e)); }
}
function updateShortcuts() {
  const base = location.origin + location.pathname;
  const set = (id, action) => { const el = $(id); if (el) el.textContent = 'bluefy://open?url=' + encodeURIComponent(base + '?do=' + action); };
  set('sc-unlock', 'unlock'); set('sc-lock', 'lock');
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => DOC_TITLES[href] ? '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>' : '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>');
  const lines = String(src).split(/\r?\n/); let html = '', inList = false, inCode = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inCode) { html += '</pre>'; inCode = false; } else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="doc-code">'; inCode = true; } continue; }
    if (inCode) { html += escHtml(ln) + '\n'; continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { html += '</ul>'; inList = false; } const lvl = h[1].length + 1; html += '<h' + lvl + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + lvl + '>'; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    if (/^\s*$/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</ul>'; if (inCode) html += '</pre>';
  return html;
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
// each help "?" shows the card's own title + hint (no separate help copy to drift from the page)
const HELP = {
  connect: ['s2Title', 'controlsHint'],
  live: ['liveTitle', 'liveHint'],
  batt: ['help_batt_t', 'help_batt_b'],
  speed: ['s3Title', 'speedHint'],
  more: ['moreTitle', 'moreHint'],
  raw: ['rawTitle', 'rawHint'],
  publiclog: ['publicLogLabel', 'help_publiclog_b'],
  diaglog: ['diagLogLabel', 'help_diaglog_b'],
  disclaimer: ['footDisclaimer', 'disclaimerText']
};
function openHelp(key) { const m = HELP[key]; if (!m) return; openHelpText(t(m[0]), t(m[1])); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); wireDocViewer();
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();
  if (!FRAME_OK) logErr('protocol self-test FAILED - builders do not match known vectors; do not trust writes');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });

  { const b = $('btn-speed-max'); if (b) b.addEventListener('click', () => guard(() => setSpeedStep(SPEED_ARG.max, t('btnSpeedMax'), true))); }
  { const b = $('btn-speed-25'); if (b) b.addEventListener('click', () => guard(() => setSpeedStep(SPEED_ARG.kmh25, t('btnSpeed25'), false))); }
  { const b = $('btn-speed-20'); if (b) b.addEventListener('click', () => guard(() => setSpeedStep(SPEED_ARG.kmh20, t('btnSpeed20'), false))); }
  { const b = $('btn-speed-6'); if (b) b.addEventListener('click', () => guard(() => setSpeedStep(SPEED_ARG.kmh6, t('btnSpeed6'), false))); }

  { const b = $('btn-immob-lock'); if (b) b.addEventListener('click', () => guard(() => doLock(true))); }
  { const b = $('btn-immob-unlock'); if (b) b.addEventListener('click', () => guard(() => doLock(false))); }

  { const b = $('btn-zerostart'); if (b) b.addEventListener('click', () => guard(doZeroStart)); }
  { const b = $('btn-light'); if (b) b.addEventListener('click', () => guard(doLight)); }
  { const b = $('btn-unit'); if (b) b.addEventListener('click', () => guard(doUnit)); }
  { const b = $('btn-resetkm'); if (b) b.addEventListener('click', () => guard(doResetKm)); }

  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-free'); if (b) b.addEventListener('click', () => guard(cmdFree)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }

  updateShortcuts();
  parseDeepLink();
  if (pendingDeepAction) { logSys(t('scPending')); tryAutoReconnect(); }
});
