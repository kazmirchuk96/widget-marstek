// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

// Завантажувач віджета Marstek (версія 3). Вставляється в Scriptable один раз.
// - Раз на пів години перевіряє, чи є на GitHub нова версія віджета.
// - Запускає нову версію лише якщо її підпис збігається з кодом підпису, збереженим на цьому iPhone.
// - Якщо нова версія не запускається — повертається до попередньої робочої.
// - Без інтернету запускає збережену версію.
const BASE = "https://raw.githubusercontent.com/kazmirchuk96/widget-marstek/main/";
const KEY_SIGN = "marstek.signkey";
const CHECK_EVERY = 30 * 60 * 1000;

const fm = FileManager.local();
const CODE_FILE = fm.joinPath(fm.libraryDirectory(), "marstek-code.js");
const META_FILE = fm.joinPath(fm.libraryDirectory(), "marstek-loader.json");

// ───────────── HMAC-SHA256 (перевірка підпису) ─────────────
function sha256(bytes) {
  const K = [];
  const H = [];
  for (let n = 2, found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (found < 8) H[found] = (Math.pow(n, 1 / 2) * 4294967296) | 0;
    K[found++] = (Math.pow(n, 1 / 3) * 4294967296) | 0;
  }
  const msg = bytes.slice();
  const bits = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const high = Math.floor(bits / 4294967296);
  for (let s = 24; s >= 0; s -= 8) msg.push((high >>> s) & 0xff);
  for (let s = 24; s >= 0; s -= 8) msg.push((bits >>> s) & 0xff);

  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (msg[off + 4 * i] << 24) | (msg[off + 4 * i + 1] << 16) | (msg[off + 4 * i + 2] << 8) | msg[off + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = [];
  for (const x of H) for (let s = 24; s >= 0; s -= 8) out.push((x >>> s) & 0xff);
  return out;
}

function utf8(str) {
  const s = unescape(encodeURIComponent(str));
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function hmacHex(key, text) {
  let k = utf8(key);
  if (k.length > 64) k = sha256(k);
  while (k.length < 64) k.push(0);
  const inner = sha256(k.map((x) => x ^ 0x36).concat(utf8(text)));
  const outer = sha256(k.map((x) => x ^ 0x5c).concat(inner));
  return outer.map((x) => ("0" + x.toString(16)).slice(-2)).join("");
}

// ───────────── Допоміжне ─────────────
function readMeta() {
  try {
    return fm.fileExists(META_FILE) ? JSON.parse(fm.readString(META_FILE)) || {} : {};
  } catch (e) {
    return {};
  }
}

function writeMeta(meta) {
  fm.writeString(META_FILE, JSON.stringify(meta));
}

// tag додається до адреси, щоб ні телефон, ні GitHub не віддали стару копію з кешу.
async function fetchText(name, timeout, tag) {
  const req = new Request(BASE + name + "?v=" + encodeURIComponent(tag));
  req.timeoutInterval = timeout;
  const text = await req.loadString();
  if (!req.response || req.response.statusCode !== 200) throw new Error("HTTP");
  return text;
}

async function run(code) {
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction(code)();
}

async function showMessage(text) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#1c1c1e");
  const head = w.addText("MARSTEK");
  head.font = Font.boldSystemFont(10);
  head.textColor = new Color("#ffffff", 0.6);
  w.addSpacer(4);
  const t = w.addText(text);
  t.font = Font.systemFont(12);
  t.textColor = Color.white();
  t.minimumScaleFactor = 0.7;
  if (config.runsInWidget) Script.setWidget(w);
  else if (config.runsInApp) await w.presentSmall();
  Script.complete();
}

const dashed = (key) => (key.match(/.{1,4}/g) || []).join("-");

async function askSignKey(note) {
  for (;;) {
    const a = new Alert();
    a.title = "Код підпису";
    a.message =
      (note ? note + "\n\n" : "") +
      "Введіть код підпису оновлень: 16 латинських літер і цифр. Він потрібен один раз: віджет запускатиме лише ті оновлення, які підписані цим кодом.";
    a.addTextField("XXXX-XXXX-XXXX-XXXX", "");
    a.addAction("Зберегти");
    a.addCancelAction("Скасувати");
    if ((await a.presentAlert()) === -1) return false;
    const key = a.textFieldValue(0).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (key.length === 16) {
      Keychain.set(KEY_SIGN, key);
      return true;
    }
    note = `У коді має бути 16 латинських літер і цифр, а розпізнано ${key.length}. Перевірте, що клавіатура англійська.`;
  }
}

// ───────────── Запуск ─────────────
async function start() {
  if (!Keychain.contains(KEY_SIGN)) {
    if (!config.runsInApp) return showMessage("Відкрийте Scriptable і запустіть скрипт Marstek, щоб завершити налаштування");
    if (!(await askSignKey())) return;
  }
  const key = Keychain.get(KEY_SIGN);
  const meta = readMeta();
  const haveCode = fm.fileExists(CODE_FILE);

  // Ручний запуск у Scriptable перевіряє оновлення завжди, віджет і автоматизація — раз на пів години.
  const due = !haveCode || config.runsInApp || Date.now() - (meta.checkedAt || 0) > CHECK_EVERY;
  let candidate = null;
  let candidateSig = null;
  let mismatch = false;
  if (due) {
    try {
      const sig = (await fetchText("Marstek.js.sig", 5, Date.now())).trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(sig) && sig !== meta.sig && sig !== meta.rejected) {
        const code = await fetchText("Marstek.js", 8, sig);
        if (hmacHex(key, code) === sig) {
          candidate = code;
          candidateSig = sig;
        } else {
          mismatch = true; // хибний код підпису або GitHub ще не оновив обидва файли
        }
      }
      meta.checkedAt = Date.now();
      writeMeta(meta);
    } catch (e) {
      // немає мережі — запустимо збережену версію
    }
  }

  if (candidate !== null) {
    try {
      await run(candidate);
      // Нова версія відпрацювала без помилок — тепер вона основна.
      fm.writeString(CODE_FILE, candidate);
      meta.sig = candidateSig;
      delete meta.rejected;
      delete meta.rejectedError;
      writeMeta(meta);
      return;
    } catch (e) {
      // Нова версія зламана: запам'ятовуємо, щоб не пробувати її знову, і запускаємо попередню.
      meta.rejected = candidateSig;
      meta.rejectedError = String(e && e.message ? e.message : e).slice(0, 200);
      writeMeta(meta);
    }
  }

  if (haveCode) return run(fm.readString(CODE_FILE));

  if (mismatch && config.runsInApp) {
    Keychain.remove(KEY_SIGN);
    if (await askSignKey(`Код підпису не підійшов. Було введено: ${dashed(key)}. Порівняйте з кодом і введіть ще раз.`)) return start();
    return;
  }
  return showMessage(
    mismatch
      ? "Код підпису не підійшов. Запустіть скрипт Marstek у Scriptable і введіть код ще раз."
      : "Не вдалося завантажити віджет. Перевірте інтернет."
  );
}

await start();
