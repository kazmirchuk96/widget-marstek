// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

// Віджет Marstek Venus для Scriptable.
// Показує: відсоток заряду, поточне навантаження, на скільки вистачить заряду.
// Дані беруться з хмари Marstek (той самий акаунт, що й у застосунку Marstek).

// ───────────── Налаштування ─────────────
// Це типові значення. Ємність, резерв і назву станції змінюють на телефоні:
// Scriptable → Marstek → «Налаштування станції».
const CONFIG = {
  capacityKwh: 5.12, // ємність ОДНІЄЇ станції, кВт·год (Venus E = 5.12, Venus C = 2.56)
  minSoc: 12,        // до якого % станція розряджається (резерв, який вона не віддає)
  deviceName: "",    // якщо станцій кілька і потрібна лише одна — її назва з застосунку
  refreshMinutes: 5, // як часто просити iOS оновлювати віджет
  idleWatts: 10,     // потужність нижче цього порога вважається нулем
};

const API_LOGIN = "https://eu.hamedata.com/app/Solar/v2_get_device.php";
const API_DEVICES = "https://eu.hamedata.com/ems/api/v1/getDeviceList";
const IGNORED_TYPES = ["HME-3"]; // лічильники, не батареї
const KEY_EMAIL = "marstek.email";
const KEY_PWD = "marstek.pwdhash";
const KEY_TOKEN = "marstek.token";
const KEY_LOGIN_AT = "marstek.loginAt";
const CACHE_FILE = "marstek-cache.json";
const HISTORY_FILE = "marstek-history.json";
const SETTINGS_FILE = "marstek-settings.json";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ───────────── MD5 (хмара Marstek приймає md5 від пароля) ─────────────
function md5(str) {
  const s = unescape(encodeURIComponent(str));
  const n = s.length;
  const m = [];
  for (let i = 0; i < n; i++) m[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
  m[n >> 2] |= 0x80 << ((n % 4) * 8);
  const total = (((n + 8) >> 6) + 1) * 16;
  m[total - 2] = n * 8;

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;

  for (let off = 0; off < total; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      const r = i >> 4;
      if (r === 0) { f = (b & c) | (~b & d); g = i; }
      else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const k = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
      const x = (a + f + k + (m[off + g] | 0)) | 0;
      const sh = S[r * 4 + (i % 4)];
      a = d; d = c; c = b;
      b = (b + ((x << sh) | (x >>> (32 - sh)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }

  let hex = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ("0" + ((w >>> (i * 8)) & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

// ───────────── Розрахунки ─────────────
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function pickDevices(devices, cfg) {
  let list = (devices || []).filter((d) => !IGNORED_TYPES.includes(d.type));
  if (cfg.deviceName) {
    const wanted = cfg.deviceName.trim().toLowerCase();
    const only = list.filter((d) => String(d.name || "").trim().toLowerCase() === wanted);
    if (only.length) list = only;
  }
  return list;
}

// Зводить дані станцій у те, що показує віджет.
// mode: "discharging" — hours = на скільки вистачить; "charging" — hours = до повного заряду;
//       "idle" — навантаження немає або ще невідоме, hours = null.
// est — результат estimateFromHistory (оцінка за зміною заряду).
function summarize(devices, cfg, est) {
  const list = pickDevices(devices, cfg);
  if (!list.length) return null;

  const soc = list.reduce((s, d) => s + num(d.soc), 0) / list.length;
  const load = list.reduce((s, d) => s + num(d.load), 0);
  const charge = list.reduce((s, d) => s + num(d.charge), 0);
  const discharge = list.reduce((s, d) => s + num(d.discharge), 0);
  const totalKwh = cfg.capacityKwh * list.length;

  let mode = "idle";
  let hours = null;
  if (charge > cfg.idleWatts && discharge <= cfg.idleWatts) {
    mode = "charging";
    hours = (totalKwh * Math.max(0, 100 - soc)) / 100 / (charge / 1000);
  } else {
    // Розряд батареї — найточніший показник; якщо його немає, рахуємо від навантаження.
    const power = discharge > cfg.idleWatts ? discharge : load;
    if (power > cfg.idleWatts) {
      mode = "discharging";
      hours = (totalKwh * Math.max(0, soc - cfg.minSoc)) / 100 / (power / 1000);
    }
  }

  // Хмара не передає потужність виходу Backup, тому коли вона показує нуль,
  // беремо оцінку за швидкістю зміни заряду.
  let estimated = false;
  let conf = null;        // "ok" | "low" — наскільки оцінці можна довіряти
  let collecting = false; // даних для оцінки ще замало
  let loadBound = null;   // заряд давно не змінюється: навантаження менше за це значення, Вт
  let shownLoad = load;
  let shownCharge = charge;
  if (mode === "idle" && est) {
    if (est.pctPerHour > 0) {
      const watts = (est.pctPerHour / 100) * totalKwh * 1000;
      if (watts > cfg.idleWatts) {
        estimated = true;
        conf = est.conf || "ok";
        if (est.dir === "down") {
          mode = "discharging";
          shownLoad = watts;
          hours = Math.max(0, soc - cfg.minSoc) / est.pctPerHour;
        } else {
          mode = "charging";
          shownCharge = watts;
          hours = Math.max(0, 100 - soc) / est.pctPerHour;
        }
      }
    } else if (est.collecting) {
      collecting = true;
    } else if (est.idle) {
      loadBound = (est.maxPctPerHour / 100) * totalKwh * 1000;
    }
  }

  return {
    soc, load: shownLoad, charge: shownCharge, discharge, mode, hours,
    estimated, conf, collecting, loadBound,
    count: list.length,
    key: list.map((d) => String(d.devid || d.sn || d.name || "")).join(","),
  };
}

// ───────────── Оцінка за зміною заряду ─────────────
// Історія — це моменти, коли відсоток заряду змінився:
//   t   — найімовірніший час зміни (середина між двома замірами),
//   err — похибка цього часу (половина паузи між замірами); null у найпершого заміру,
//         бо тоді відомо лише, що заряд уже був таким.
// key — які станції в історії; якщо акаунт або станцію змінено, історія починається заново.
function updateHistory(hist, t, soc, key) {
  key = key || "";
  const ok = hist && hist.v === 2 && hist.key === key && Array.isArray(hist.samples);
  const h = ok ? { v: 2, key, samples: hist.samples.slice(), lastSeen: hist.lastSeen } : { v: 2, key, samples: [], lastSeen: 0 };
  soc = Math.round(soc);
  if (!h.samples.length) {
    h.samples.push({ t, soc, err: null });
    h.lastSeen = t;
    return h;
  }
  if (t <= h.lastSeen) return h;
  const last = h.samples[h.samples.length - 1];
  if (soc !== last.soc) {
    const half = (t - h.lastSeen) / 2;
    h.samples.push({ t: Math.round(h.lastSeen + half), soc, err: Math.round(half) });
    if (h.samples.length > 80) h.samples = h.samples.slice(-80);
  }
  h.lastSeen = t;
  return h;
}

// Повертає одне з:
//   { pctPerHour, dir: "down" | "up", conf: "ok" | "low" } — заряд змінюється з такою швидкістю;
//   { collecting: true } — даних ще замало;
//   { idle: true, maxPctPerHour } — заряд давно стоїть, швидкість не більша за maxPctPerHour;
//   null — історії немає.
function estimateFromHistory(hist) {
  const s = hist && hist.v === 2 && Array.isArray(hist.samples) ? hist.samples : [];
  if (!s.length) return null;
  const last = s[s.length - 1];
  // Скільки часу ми вже бачимо поточний відсоток без змін.
  const quiet = Math.max(0, hist.lastSeen - (last.t + (last.err || 0)));
  const stalled = () => (quiet < 20 * MINUTE ? { collecting: true } : { idle: true, maxPctPerHour: HOUR / quiet });
  if (s.length < 2) return stalled();
  const dir = Math.sign(s[s.length - 2].soc - last.soc); // 1 — розряд, -1 — заряд
  if (dir === 0) return stalled();

  // Беремо найкоротше свіже вікно, у якому час відомий достатньо точно (похибка до 20%):
  // так оцінка швидко реагує на зміну навантаження. Якщо такого немає — найточніше з наявних.
  let best = null;
  for (let i = s.length - 2; i >= 0; i--) {
    if (Math.sign(s[i].soc - s[i + 1].soc) !== dir) break;
    const span = last.t - s[i].t;
    if (span > 3 * HOUR) break;
    if (span <= 0) continue;
    const rel = ((s[i].err === null ? span : s[i].err) + (last.err || 0)) / span;
    const cand = { pctPerHour: Math.abs(s[i].soc - last.soc) / (span / HOUR), rel };
    if (!best || rel < best.rel) best = cand;
    if (rel <= 0.2) break;
  }
  // Якщо час початку вікна невідомий (найперший замір), оцінка може помилятися в рази — краще зачекати.
  if (!best || best.rel >= 1) return stalled();

  let pctPerHour = best.pctPerHour;
  let conf = best.rel <= 0.35 ? "ok" : "low";
  const expected = HOUR / pctPerHour; // скільки триває один відсоток
  // Наступний відсоток надто затримується — навантаження зникло (або повернулося світло).
  if (quiet > Math.max(4 * expected, 30 * MINUTE)) return stalled();
  if (quiet > 1.5 * expected) {
    pctPerHour = Math.min(pctPerHour, HOUR / quiet);
    conf = "low";
  }
  return { pctPerHour, dir: dir === 1 ? "down" : "up", conf };
}

// ───────────── Форматування ─────────────
function formatDuration(hours) {
  if (hours === null || !Number.isFinite(hours)) return "—";
  const mins = Math.round(hours * 60);
  if (mins < 1) return "0 хв";
  if (mins >= 99 * 60) return "99+ год";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} хв`;
  return m === 0 ? `${h} год` : `${h} год ${m} хв`;
}

// Для оцінок: без хибної точності — що довший час, то грубіше округлення.
function formatApprox(hours) {
  if (hours === null || !Number.isFinite(hours)) return "—";
  const mins = hours * 60;
  const step = mins >= 600 ? 60 : mins >= 120 ? 10 : 5;
  return "≈" + formatDuration((Math.round(mins / step) * step) / 60);
}

function formatWatts(w) {
  return w >= 1000 ? `${(w / 1000).toFixed(2).replace(".", ",")} кВт` : `${Math.round(w)} Вт`;
}

// Що саме показати в рядках «Навантаження» і «Вистачить на».
function metrics(sum, cfg) {
  const low = sum.estimated && sum.conf === "low";
  let loadValue = "—";
  if (sum.mode === "charging") {
    loadValue = sum.load > cfg.idleWatts ? formatWatts(sum.load) : "—";
  } else if (sum.estimated) {
    loadValue = "≈" + formatWatts(Math.round(sum.load / 10) * 10);
  } else if (sum.load > cfg.idleWatts) {
    loadValue = formatWatts(sum.load);
  } else if (sum.collecting) {
    loadValue = "рахую…";
  } else if (sum.loadBound !== null) {
    loadValue = sum.loadBound <= 20 ? "≈0 Вт" : "<" + formatWatts(Math.ceil(sum.loadBound / 10) * 10);
  }

  let timeValue = "—";
  if (sum.mode !== "idle") timeValue = sum.estimated ? formatApprox(sum.hours) : formatDuration(sum.hours);

  return {
    loadTitle: low && sum.mode === "discharging" ? "Навантаження (уточнюю)" : "Навантаження",
    loadValue,
    timeTitle: sum.mode === "charging" ? "До повного заряду" : "Вистачить на",
    timeValue,
    chargeValue: (sum.estimated ? "≈" : "") + formatWatts(sum.estimated ? Math.round(sum.charge / 10) * 10 : sum.charge),
    low,
  };
}

// Сирі дані хмари для діагностики; ідентифікатори пристрою приховано.
function diagnosticsText(devices, now) {
  const secret = /sn|devid|mac|token|mail|uid|^id$|password|pwd|salt/i;
  const masked = (devices || []).map((d) => {
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      out[k] = secret.test(k) && v !== null && v !== "" ? String(v).slice(0, 3) + "…" : v;
    }
    return out;
  });
  const stamp = new Date(now);
  const pad = (x) => String(x).padStart(2, "0");
  const time = `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`;
  return `Запит о ${time} (unix ${Math.floor(now / 1000)})\n` + JSON.stringify(masked, null, 2);
}

// ───────────── Файли на телефоні ─────────────
function libPath(name) {
  const fm = FileManager.local();
  return fm.joinPath(fm.libraryDirectory(), name);
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
}

function readJSON(path) {
  const fm = FileManager.local();
  try {
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (e) {
    return null; // зіпсований файл — починаємо заново
  }
}

function removeFile(path) {
  const fm = FileManager.local();
  try {
    if (fm.fileExists(path)) fm.remove(path);
  } catch (e) {}
}

// Налаштування, збережені на телефоні, перекривають типові з CONFIG.
function validSettings(raw) {
  const out = {};
  if (!raw) return out;
  const cap = Number(String(raw.capacityKwh).replace(",", "."));
  if (Number.isFinite(cap) && cap >= 0.5 && cap <= 100) out.capacityKwh = cap;
  const min = Number(String(raw.minSoc).replace(",", "."));
  if (Number.isFinite(min) && min >= 0 && min <= 90) out.minSoc = min;
  if (typeof raw.deviceName === "string") out.deviceName = raw.deviceName.trim();
  return out;
}

function loadSettings() {
  Object.assign(CONFIG, validSettings(readJSON(libPath(SETTINGS_FILE))));
}

// ───────────── Хмара Marstek ─────────────
async function getJSON(req) {
  req.timeoutInterval = 8;
  try {
    return await req.loadJSON();
  } catch (e) {
    throw new Error("Немає зв'язку з хмарою Marstek");
  }
}

async function login() {
  const url =
    `${API_LOGIN}?pwd=${encodeURIComponent(Keychain.get(KEY_PWD))}` +
    `&mailbox=${encodeURIComponent(Keychain.get(KEY_EMAIL))}`;
  const req = new Request(url);
  req.method = "POST";
  Keychain.set(KEY_LOGIN_AT, String(Date.now()));
  const data = await getJSON(req);
  if (!data || !data.token) throw new Error("Невірний email або пароль Marstek");
  Keychain.set(KEY_TOKEN, String(data.token));
  return String(data.token);
}

async function fetchDevices() {
  const load = (token) => getJSON(new Request(`${API_DEVICES}?token=${encodeURIComponent(token)}`));
  // Повторний вхід — не частіше ніж раз на 10 хвилин (крім ручного запуску),
  // щоб не входити знову й знову, коли хмара відповідає чимось незвичним.
  const relogin = () => {
    const lastAt = Keychain.contains(KEY_LOGIN_AT) ? Number(Keychain.get(KEY_LOGIN_AT)) : 0;
    if (!config.runsInApp && Date.now() - lastAt < 10 * MINUTE) {
      throw new Error("Хмара Marstek не віддала дані, спробую пізніше");
    }
    return login();
  };
  let token = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : await relogin();
  let data = await load(token);
  if (!data || !Array.isArray(data.data)) {
    // Найімовірніше, токен прострочений — входимо заново й пробуємо ще раз.
    token = await relogin();
    data = await load(token);
  }
  if (!data || !Array.isArray(data.data)) throw new Error("Хмара Marstek не повернула дані");
  return data.data;
}

async function loadState() {
  const fm = FileManager.local();
  try {
    const devices = await fetchDevices();
    const now = summarize(devices, CONFIG);
    let history = null;
    if (now) {
      // Читаємо й одразу записуємо без пауз, щоб паралельний запуск (автоматизація) не загубив замір.
      // Час беремо свій: report_time у хмарі не оновлюється разом із зарядом.
      history = updateHistory(readJSON(libPath(HISTORY_FILE)), Date.now(), now.soc, now.key);
      fm.writeString(libPath(HISTORY_FILE), JSON.stringify(history));
    }
    const state = { devices, fetchedAt: Date.now(), history };
    fm.writeString(cachePath(), JSON.stringify(state));
    return { ...state, stale: false };
  } catch (e) {
    const state = readJSON(cachePath());
    if (state && Array.isArray(state.devices)) return { ...state, stale: true, error: String(e.message || e) };
    throw e;
  }
}

// ───────────── Вхід і налаштування (лише в Scriptable) ─────────────
async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("Гаразд");
  await a.presentAlert();
}

async function askCredentials() {
  const a = new Alert();
  a.title = "Акаунт Marstek";
  a.message =
    "Email і пароль від застосунку Marstek. Зберігаються лише у Keychain цього iPhone; пароль — у вигляді md5-хешу.";
  a.addTextField("Email", Keychain.contains(KEY_EMAIL) ? Keychain.get(KEY_EMAIL) : "");
  a.addSecureTextField("Пароль", "");
  a.addAction("Зберегти");
  a.addCancelAction("Скасувати");
  if ((await a.presentAlert()) === -1) return false;
  const email = a.textFieldValue(0).trim();
  const pwd = a.textFieldValue(1);
  if (!email || !pwd) {
    await notify("Акаунт не змінено", "Потрібні і email, і пароль.");
    return false;
  }

  // Одразу перевіряємо вхід; якщо не вдався — повертаємо попередній акаунт.
  const keys = [KEY_EMAIL, KEY_PWD, KEY_TOKEN];
  const old = keys.map((k) => (Keychain.contains(k) ? Keychain.get(k) : null));
  Keychain.set(KEY_EMAIL, email);
  Keychain.set(KEY_PWD, md5(pwd));
  try {
    await login();
  } catch (e) {
    keys.forEach((k, i) => {
      if (old[i] !== null) Keychain.set(k, old[i]);
      else if (Keychain.contains(k)) Keychain.remove(k);
    });
    await notify("Не вдалося увійти", String(e.message || e));
    return false;
  }
  removeFile(cachePath()); // щоб без зв'язку не показати дані попереднього акаунта
  return true;
}

const hasCredentials = () => Keychain.contains(KEY_EMAIL) && Keychain.contains(KEY_PWD);

async function editSettings() {
  const a = new Alert();
  a.title = "Налаштування станції";
  a.message =
    "Ємність однієї станції в кВт·год (Venus E — 5,12). Резерв — відсоток, нижче якого станція не розряджається " +
    "(100 мінус Depth of Discharge із застосунку Marstek). Назва потрібна, лише якщо станцій кілька.";
  a.addTextField("Ємність, кВт·год", String(CONFIG.capacityKwh).replace(".", ","));
  a.addTextField("Резерв, %", String(CONFIG.minSoc).replace(".", ","));
  a.addTextField("Назва станції (необов'язково)", CONFIG.deviceName);
  a.addAction("Зберегти");
  a.addCancelAction("Скасувати");
  if ((await a.presentAlert()) === -1) return;
  const raw = { capacityKwh: a.textFieldValue(0), minSoc: a.textFieldValue(1), deviceName: a.textFieldValue(2) };
  const clean = validSettings(raw);
  if (!("capacityKwh" in clean) || !("minSoc" in clean)) {
    await notify("Не збережено", "Ємність має бути від 0,5 до 100 кВт·год, резерв — від 0 до 90%.");
    return;
  }
  FileManager.local().writeString(libPath(SETTINGS_FILE), JSON.stringify(clean));
  loadSettings();
}

// ───────────── Віджет ─────────────
const GREEN = "#30d158";
const ORANGE = "#ff9f0a";
const RED = "#ff453a";

// Колір залежить від корисного заряду — того, що лишилося понад резерв.
function socColorHex(soc, minSoc) {
  const usable = ((soc - minSoc) / Math.max(1, 100 - minSoc)) * 100;
  if (usable <= 10) return RED;
  if (usable <= 30) return ORANGE;
  return GREEN;
}

// Ширина вмісту віджета. Scriptable її не повідомляє, тому оцінюємо за шириною екрана — із запасом,
// щоб смужка ніколи не вилізла за край.
function contentWidth(wide) {
  let screen = 390;
  try {
    const size = Device.screenSize();
    const side = Math.min(size.width, size.height);
    if (side > 0) screen = side;
  } catch (e) {}
  const widget = wide ? Math.min(364, screen * 0.84) : Math.min(170, screen * 0.4);
  return Math.floor(widget - 28);
}

function barImage(soc, minSoc, color, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), height / 2, height / 2);
  ctx.addPath(track);
  ctx.setFillColor(new Color("#ffffff", 0.15));
  ctx.fillPath();
  const w = Math.max(height, (width * Math.min(100, Math.max(0, soc))) / 100);
  const fill = new Path();
  fill.addRoundedRect(new Rect(0, 0, w, height), height / 2, height / 2);
  ctx.addPath(fill);
  ctx.setFillColor(color);
  ctx.fillPath();
  // Позначка резерву: лівіше від неї — заряд, який станція не віддає.
  if (minSoc > 0 && minSoc < 100) {
    ctx.setFillColor(soc > minSoc ? new Color("#000000", 0.6) : new Color("#ffffff", 0.6));
    ctx.fillRect(new Rect((width * minSoc) / 100 - 1, 0, 2, height));
  }
  return ctx.getImage();
}

// Сьогоднішній час — «21:42», давніший — із датою, щоб учорашні дані не здавалися свіжими.
function timeLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const df = new DateFormatter();
  df.dateFormat = sameDay ? "HH:mm" : "dd.MM HH:mm";
  return df.string(d);
}

// Натискання на віджет одразу оновлює дані й показує їх, без меню.
function tapUrl(family) {
  let name = "Marstek";
  try {
    name = Script.name();
  } catch (e) {}
  return `scriptable:///run/${encodeURIComponent(name)}?refresh=1&family=${encodeURIComponent(family)}`;
}

function messageWidget(text) {
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
  return w;
}

function buildLockScreen(sum, m, family, offline) {
  const w = new ListWidget();
  const soc = `${Math.round(sum.soc)}%`;
  if (family === "accessoryCircular") {
    const t = w.addText(soc);
    t.font = Font.boldSystemFont(15);
    t.centerAlignText();
    t.minimumScaleFactor = 0.6;
    return w;
  }
  if (family === "accessoryInline") {
    w.addText(offline ? `Marstek ${soc} · немає зв'язку` : `Marstek ${soc} · ${m.timeValue === "—" ? m.loadValue : m.timeValue}`);
    return w;
  }
  const l1 = w.addText(`Marstek ${soc} · ${offline ? "—" : m.loadValue}`);
  l1.font = Font.boldSystemFont(13);
  l1.lineLimit = 1;
  l1.minimumScaleFactor = 0.7;
  const l2 = w.addText(offline ? "Немає зв'язку з хмарою" : `${m.timeTitle}: ${m.timeValue}`);
  l2.font = Font.systemFont(12);
  l2.lineLimit = 1;
  l2.minimumScaleFactor = 0.7;
  return w;
}

function addMetric(stack, title, value, valueColor) {
  const col = stack.addStack();
  col.layoutVertically();
  const t = col.addText(title);
  t.font = Font.systemFont(10);
  t.textColor = new Color("#ffffff", 0.6);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  const v = col.addText(value);
  v.font = Font.semiboldSystemFont(15);
  v.textColor = valueColor || Color.white();
  v.lineLimit = 1;
  v.minimumScaleFactor = 0.6;
  return col;
}

function buildWidget(state, family) {
  // Без зв'язку понад пів години оцінки вже нічого не варті — показуємо лише останній відомий заряд.
  const offline = state.stale && Date.now() - state.fetchedAt > 30 * MINUTE;
  const sum = summarize(state.devices, CONFIG, offline ? null : estimateFromHistory(state.history));
  if (!sum) return messageWidget("В акаунті Marstek не знайдено станцій. Перевірте назву станції в налаштуваннях.");
  const m = metrics(sum, CONFIG);

  if (family.startsWith("accessory")) return buildLockScreen(sum, m, family, offline);

  const wide = family !== "small";
  const dim = new Color("#ffffff", 0.55);
  const color = offline ? dim : new Color(socColorHex(sum.soc, CONFIG.minSoc));
  const w = new ListWidget();
  const bg = new LinearGradient();
  bg.colors = [new Color("#1f2a24"), new Color("#101214")];
  bg.locations = [0, 1];
  w.backgroundGradient = bg;
  w.setPadding(14, 14, 12, 14);

  // Заголовок: час останніх отриманих даних
  const head = w.addStack();
  head.centerAlignContent();
  const name = head.addText("MARSTEK");
  name.font = Font.boldSystemFont(10);
  name.textColor = new Color("#ffffff", 0.6);
  head.addSpacer();
  const upd = head.addText((state.stale ? "⚠ " : "") + timeLabel(state.fetchedAt));
  upd.font = Font.systemFont(10);
  upd.textColor = state.stale ? new Color(ORANGE) : new Color("#ffffff", 0.45);
  upd.lineLimit = 1;
  upd.minimumScaleFactor = 0.7;

  w.addSpacer(2);

  // Відсоток заряду
  const socRow = w.addStack();
  socRow.bottomAlignContent();
  const socText = socRow.addText(`${Math.round(sum.soc)}%`);
  socText.font = Font.boldRoundedSystemFont(wide ? 40 : 34);
  socText.textColor = color;
  if (sum.mode === "charging" && !offline) {
    socRow.addSpacer(6);
    const ch = socRow.addText(`⚡ +${m.chargeValue}`);
    ch.font = Font.systemFont(11);
    ch.textColor = new Color(GREEN);
    ch.lineLimit = 1;
    ch.minimumScaleFactor = 0.6;
  }

  w.addSpacer(4);
  const barWidth = contentWidth(wide);
  const bar = w.addImage(barImage(sum.soc, CONFIG.minSoc, color, barWidth, 6));
  bar.imageSize = new Size(barWidth, 6);
  w.addSpacer();

  // Навантаження і час роботи
  if (offline) {
    addMetric(w, "Немає зв'язку з хмарою", "дані застаріли", new Color(ORANGE));
    return w;
  }
  const loadColor = m.low || sum.collecting ? dim : null;
  const timeColor = sum.mode === "charging" ? new Color(GREEN) : m.low ? dim : null;
  if (wide) {
    const row = w.addStack();
    addMetric(row, m.loadTitle, m.loadValue, loadColor);
    row.addSpacer();
    addMetric(row, m.timeTitle, m.timeValue, timeColor);
    row.addSpacer();
  } else {
    addMetric(w, m.loadTitle, m.loadValue, loadColor);
    w.addSpacer(4);
    addMetric(w, m.timeTitle, m.timeValue, timeColor);
  }

  return w;
}

// ───────────── Запуск ─────────────
async function showDiagnostics() {
  let text;
  try {
    text = diagnosticsText(await fetchDevices(), Date.now());
  } catch (e) {
    text = `Помилка: ${e.message || e}`;
  }
  text += "\n\nНалаштування: " + JSON.stringify({ capacityKwh: CONFIG.capacityKwh, minSoc: CONFIG.minSoc, deviceName: CONFIG.deviceName });
  text += "\n\nІсторія заряду:\n" + JSON.stringify(readJSON(libPath(HISTORY_FILE)));
  text += "\n\nЗавантажувач: " + JSON.stringify(readJSON(libPath("marstek-loader.json")));
  await QuickLook.present(text);
}

async function main() {
  loadSettings();
  const query = (typeof args !== "undefined" && args && args.queryParameters) || {};
  const fromTap = query.refresh === "1"; // відкрито натисканням на віджет
  let preview = fromTap && query.family === "medium" ? "medium" : "small";

  if (config.runsInApp) {
    if (!hasCredentials()) {
      if (!(await askCredentials())) return;
    } else if (!fromTap) {
      const menu = new Alert();
      menu.title = "Marstek";
      menu.addAction("Оновити й показати малий віджет");
      menu.addAction("Показати середній віджет");
      menu.addAction("Налаштування станції");
      menu.addAction("Змінити акаунт");
      menu.addAction("Діагностика");
      menu.addCancelAction("Закрити");
      const choice = await menu.presentSheet();
      if (choice === -1) return;
      if (choice === 1) preview = "medium";
      if (choice === 2) await editSettings();
      if (choice === 3 && !(await askCredentials())) return;
      if (choice === 4) return showDiagnostics();
    }
  }

  const family = config.runsInWidget ? config.widgetFamily || "small" : preview;
  let widget;
  if (!hasCredentials()) {
    widget = messageWidget("Відкрийте Scriptable і запустіть скрипт Marstek, щоб увійти в акаунт");
  } else {
    try {
      widget = buildWidget(await loadState(), family);
    } catch (e) {
      widget = messageWidget(String(e.message || e));
    }
  }
  widget.url = tapUrl(family);
  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);

  if (config.runsInWidget) Script.setWidget(widget);
  else if (config.runsInApp) await (preview === "medium" ? widget.presentMedium() : widget.presentSmall());
  // Запуск із «Команд» (автоматизація): дані вже отримано й історію заряду поповнено, показувати нічого не треба.
  Script.complete();
}

if (typeof ListWidget === "undefined") {
  // Запуск поза Scriptable (тести в Node).
  module.exports = {
    md5, summarize, updateHistory, estimateFromHistory, metrics, formatDuration, formatApprox, formatWatts,
    diagnosticsText, validSettings, socColorHex, CONFIG,
  };
} else {
  await main();
}
