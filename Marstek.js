// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

// Віджет Marstek Venus для Scriptable.
// Показує: відсоток заряду, поточне навантаження, на скільки вистачить заряду.
// Дані беруться з хмари Marstek (той самий акаунт, що й у застосунку Marstek).

// ───────────── Налаштування ─────────────
const CONFIG = {
  capacityKwh: 5.12, // ємність ОДНІЄЇ станції, кВт·год (Venus E = 5.12, Venus C = 2.56)
  minSoc: 12,       // до якого % станція розряджається (резерв, який вона не віддає)
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
const CACHE_FILE = "marstek-cache.json";

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
//       "idle" — навантаження немає, hours = null.
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
  let power = 0;
  if (charge > cfg.idleWatts && discharge <= cfg.idleWatts) {
    mode = "charging";
    power = charge;
    hours = (totalKwh * Math.max(0, 100 - soc)) / 100 / (charge / 1000);
  } else {
    // Розряд батареї — найточніший показник; якщо його немає, рахуємо від навантаження.
    power = discharge > cfg.idleWatts ? discharge : load;
    if (power > cfg.idleWatts) {
      mode = "discharging";
      hours = (totalKwh * Math.max(0, soc - cfg.minSoc)) / 100 / (power / 1000);
    }
  }

  const times = list.map((d) => num(d.report_time)).filter((t) => t > 1e9);
  const reportedAt = times.length ? Math.min(...times) * 1000 : null;

  // Хмара не передає потужність виходу Backup, тому коли вона показує нуль,
  // беремо оцінку за швидкістю зміни заряду (est.pctPerHour — відсотків за годину).
  let estimated = false;
  let shownLoad = load;
  let shownCharge = charge;
  if (mode === "idle" && est && est.pctPerHour > 0) {
    const watts = (est.pctPerHour / 100) * totalKwh * 1000;
    if (watts > cfg.idleWatts) {
      estimated = true;
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
  }

  return {
    soc, load: shownLoad, charge: shownCharge, discharge, mode, hours, estimated,
    count: list.length, reportedAt,
  };
}

// ───────────── Оцінка за зміною заряду ─────────────
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Історія — це моменти, коли відсоток заряду змінився. edge = true означає, що момент зміни
// відомий досить точно (попередній замір був не давніше 30 хв тому).
function updateHistory(hist, t, soc) {
  const h = hist && Array.isArray(hist.samples) ? { samples: hist.samples.slice(), lastSeen: hist.lastSeen } : { samples: [], lastSeen: 0 };
  soc = Math.round(soc);
  if (!h.samples.length) {
    h.samples.push({ t, soc, edge: false });
    h.lastSeen = t;
    return h;
  }
  if (t <= h.lastSeen) return h;
  const last = h.samples[h.samples.length - 1];
  if (soc !== last.soc) {
    const gap = t - h.lastSeen;
    // Зміна сталася десь між двома замірами — беремо середину.
    h.samples.push({ t: Math.round((h.lastSeen + t) / 2), soc, edge: gap <= 30 * MINUTE });
    if (h.samples.length > 60) h.samples = h.samples.slice(-60);
  }
  h.lastSeen = t;
  return h;
}

// Повертає { pctPerHour, dir: "down" | "up" } або null, якщо даних замало чи заряд давно не змінюється.
function estimateFromHistory(hist, now) {
  const s = hist && Array.isArray(hist.samples) ? hist.samples : [];
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const dir = Math.sign(s[s.length - 2].soc - last.soc); // 1 — розряд, -1 — заряд
  if (dir === 0) return null;

  // Ідемо назад, доки заряд змінюється в той самий бік, не далі ніж на 2 години.
  let i = s.length - 1;
  while (i > 0 && s[i].edge && Math.sign(s[i - 1].soc - s[i].soc) === dir && last.t - s[i - 1].t <= 2 * HOUR) i--;
  // Перший замір після паузи неточний у часі: якщо точок досить, відкидаємо його.
  if (!s[i].edge && s.length - 1 - i >= 2) i++;
  const start = s[i];
  const dSoc = Math.abs(start.soc - last.soc);
  const span = last.t - start.t;
  if (dSoc === 0 || span <= 0) return null;

  let pctPerHour = dSoc / (span / HOUR);
  const idle = now - last.t;
  if (idle > 2 * HOUR) return null; // заряд давно стоїть — навантаження немає
  // Якщо наступний відсоток затримується, навантаження впало — знижуємо оцінку.
  if (idle > (2 * span) / dSoc) pctPerHour = Math.min(pctPerHour, 1 / (idle / HOUR));
  return { pctPerHour, dir: dir === 1 ? "down" : "up" };
}

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

function formatWatts(w) {
  return w >= 1000 ? `${(w / 1000).toFixed(2).replace(".", ",")} кВт` : `${Math.round(w)} Вт`;
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

// ───────────── Хмара Marstek ─────────────
async function login() {
  const url =
    `${API_LOGIN}?pwd=${encodeURIComponent(Keychain.get(KEY_PWD))}` +
    `&mailbox=${encodeURIComponent(Keychain.get(KEY_EMAIL))}`;
  const req = new Request(url);
  req.method = "POST";
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (!data || !data.token) throw new Error("Не вдалося увійти: перевірте email і пароль");
  Keychain.set(KEY_TOKEN, String(data.token));
  return String(data.token);
}

async function fetchDevices() {
  const load = async (token) => {
    const req = new Request(`${API_DEVICES}?token=${encodeURIComponent(token)}`);
    req.timeoutInterval = 15;
    return req.loadJSON();
  };
  let token = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : await login();
  let data = await load(token);
  if (!data || !Array.isArray(data.data)) {
    // Токен прострочений — входимо заново й пробуємо ще раз.
    token = await login();
    data = await load(token);
  }
  if (!data || !Array.isArray(data.data)) throw new Error("Хмара Marstek не повернула дані");
  return data.data;
}

function historyPath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.libraryDirectory(), "marstek-history.json");
}

function readHistory() {
  const fm = FileManager.local();
  try {
    return fm.fileExists(historyPath()) ? JSON.parse(fm.readString(historyPath())) : null;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
}

async function loadState() {
  const fm = FileManager.local();
  try {
    const devices = await fetchDevices();
    let history = readHistory();
    const now = summarize(devices, CONFIG);
    if (now) {
      history = updateHistory(history, now.reportedAt || Date.now(), now.soc);
      fm.writeString(historyPath(), JSON.stringify(history));
    }
    const state = { devices, fetchedAt: Date.now(), history };
    fm.writeString(cachePath(), JSON.stringify(state));
    return { ...state, stale: false };
  } catch (e) {
    if (fm.fileExists(cachePath())) {
      const state = JSON.parse(fm.readString(cachePath()));
      return { ...state, stale: true, error: String(e.message || e) };
    }
    throw e;
  }
}

// ───────────── Вхід ─────────────
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
  if (!email || !pwd) return false;
  Keychain.set(KEY_EMAIL, email);
  Keychain.set(KEY_PWD, md5(pwd));
  if (Keychain.contains(KEY_TOKEN)) Keychain.remove(KEY_TOKEN);
  return true;
}

const hasCredentials = () => Keychain.contains(KEY_EMAIL) && Keychain.contains(KEY_PWD);

// ───────────── Віджет ─────────────
function socColor(soc) {
  if (soc <= 20) return new Color("#ff453a");
  if (soc <= 40) return new Color("#ff9f0a");
  return new Color("#30d158");
}

function barImage(soc, color, width, height) {
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
  return ctx.getImage();
}

function timeLabel(ms) {
  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  return df.string(new Date(ms));
}

function runtimeTitle(mode) {
  if (mode === "charging") return "До повного заряду";
  return "Вистачить на";
}

function messageWidget(text) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#1c1c1e");
  const t = w.addText(text);
  t.font = Font.systemFont(13);
  t.textColor = Color.white();
  return w;
}

// Оцінку показуємо зі знаком ≈ і округлюємо до десятків; нуль від хмари — як «—».
function loadLabel(sum) {
  if (sum.load <= CONFIG.idleWatts) return "—";
  return sum.estimated ? `≈${formatWatts(Math.round(sum.load / 10) * 10)}` : formatWatts(sum.load);
}

function chargeLabel(sum) {
  return sum.estimated ? `≈${formatWatts(Math.round(sum.charge / 10) * 10)}` : formatWatts(sum.charge);
}

function buildLockScreen(sum) {
  const w = new ListWidget();
  const l1 = w.addText(`🔋 ${Math.round(sum.soc)}%  ·  ${loadLabel(sum)}`);
  l1.font = Font.boldSystemFont(14);
  const l2 = w.addText(
    sum.mode === "idle" ? "Без навантаження" : `${runtimeTitle(sum.mode)}: ${formatDuration(sum.hours)}`
  );
  l2.font = Font.systemFont(12);
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

function buildWidget(state) {
  const sum = summarize(state.devices, CONFIG, estimateFromHistory(state.history, Date.now()));
  if (!sum) return messageWidget("У акаунті Marstek не знайдено станцій");

  const family = config.widgetFamily || "small";
  if (family.startsWith("accessory")) return buildLockScreen(sum);

  const wide = family !== "small";
  const color = socColor(sum.soc);
  const w = new ListWidget();
  const bg = new LinearGradient();
  bg.colors = [new Color("#1f2a24"), new Color("#101214")];
  bg.locations = [0, 1];
  w.backgroundGradient = bg;
  w.setPadding(14, 14, 12, 14);

  // Заголовок
  const head = w.addStack();
  head.centerAlignContent();
  const name = head.addText("MARSTEK");
  name.font = Font.boldSystemFont(10);
  name.textColor = new Color("#ffffff", 0.6);
  head.addSpacer();
  const when = sum.reportedAt || state.fetchedAt;
  const upd = head.addText((state.stale ? "⚠ " : "") + timeLabel(when));
  upd.font = Font.systemFont(10);
  upd.textColor = state.stale ? new Color("#ff9f0a") : new Color("#ffffff", 0.45);

  w.addSpacer(2);

  // Відсоток заряду
  const socRow = w.addStack();
  socRow.bottomAlignContent();
  const socText = socRow.addText(`${Math.round(sum.soc)}%`);
  socText.font = Font.boldRoundedSystemFont(wide ? 40 : 34);
  socText.textColor = color;
  if (sum.mode === "charging") {
    socRow.addSpacer(6);
    const ch = socRow.addText(`⚡ +${chargeLabel(sum)}`);
    ch.font = Font.systemFont(11);
    ch.textColor = new Color("#30d158");
    ch.lineLimit = 1;
    ch.minimumScaleFactor = 0.6;
  }

  w.addSpacer(4);
  const bar = w.addImage(barImage(sum.soc, color, wide ? 300 : 130, 6));
  bar.imageSize = new Size(wide ? 300 : 130, 6);
  w.addSpacer();

  // Навантаження і час роботи
  const runtime = sum.mode === "idle" ? "—" : formatDuration(sum.hours);
  if (wide) {
    const row = w.addStack();
    addMetric(row, "Навантаження", loadLabel(sum));
    row.addSpacer();
    addMetric(row, runtimeTitle(sum.mode), runtime, sum.mode === "charging" ? new Color("#30d158") : null);
    row.addSpacer();
  } else {
    addMetric(w, "Навантаження", loadLabel(sum));
    w.addSpacer(4);
    addMetric(w, runtimeTitle(sum.mode), runtime, sum.mode === "charging" ? new Color("#30d158") : null);
  }

  return w;
}

// ───────────── Запуск ─────────────
async function main() {
  if (config.runsInApp) {
    if (!hasCredentials()) {
      if (!(await askCredentials())) return;
    } else {
      const menu = new Alert();
      menu.title = "Marstek";
      menu.addAction("Показати віджет");
      menu.addAction("Змінити акаунт");
      menu.addAction("Дані з хмари (діагностика)");
      menu.addCancelAction("Закрити");
      const choice = await menu.presentSheet();
      if (choice === -1) return;
      if (choice === 1 && !(await askCredentials())) return;
      if (choice === 2) {
        let text;
        try {
          text = diagnosticsText(await fetchDevices(), Date.now());
          text += "\n\nІсторія заряду:\n" + JSON.stringify(readHistory());
        } catch (e) {
          text = `Помилка: ${e.message || e}`;
        }
        Pasteboard.copyString(text);
        await QuickLook.present(text);
        return;
      }
    }
  }

  let widget;
  if (!hasCredentials()) {
    widget = messageWidget("Відкрийте Scriptable і запустіть скрипт Marstek, щоб увійти в акаунт");
  } else {
    try {
      widget = buildWidget(await loadState());
    } catch (e) {
      widget = messageWidget(`Marstek: ${e.message || e}`);
    }
  }
  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);

  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentSmall();
  Script.complete();
}

if (typeof ListWidget === "undefined") {
  // Запуск поза Scriptable (тести в Node).
  module.exports = { md5, summarize, formatDuration, formatWatts, diagnosticsText, updateHistory, estimateFromHistory, CONFIG };
} else {
  await main();
}
