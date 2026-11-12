// Тести для Node: чиста логіка + прогін віджета й завантажувача на заглушках Scriptable.
// Запуск: node test/test.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "Marstek.js"), "utf8");
const loader = fs.readFileSync(path.join(__dirname, "..", "Loader.js"), "utf8");
const AsyncFunction = (async () => {}).constructor;
const MIN = 60000;
const HOUR = 60 * MIN;
const T0 = 1794000000000;

// ───────────── Заглушки Scriptable ─────────────
// env — спільний стан «телефона»: Keychain, файли, мережа. Кожен запуск скрипта отримує свіжі глобальні об'єкти.
function makeEnv() {
  return {
    kc: {}, files: {}, calls: [], texts: [], widget: null, presented: null, alerts: [],
    net: {}, // url-фрагмент → функція, що повертає відповідь або кидає помилку
    alertAnswers: [], // відповіді на діалоги по черзі: { choose, fields }
  };
}

function install(env, mode, family, query) {
  env.texts = [];
  env.widget = null;
  env.presented = null;
  const any = () => new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : any()),
    set: () => true, apply: () => any(), construct: () => any(),
  });
  const stack = () => ({
    addText: (s) => { env.texts.push(s); return { centerAlignText() {} }; },
    addStack: stack, addSpacer() {}, addImage: () => ({}),
    layoutVertically() {}, centerAlignContent() {}, bottomAlignContent() {}, setPadding() {},
  });
  const g = {
    module: {},
    config: { runsInWidget: mode === "widget", runsInApp: mode === "app", widgetFamily: mode === "widget" ? family : undefined },
    args: { queryParameters: query || {} },
    ListWidget: function () {
      const w = stack();
      w.presentSmall = async () => { env.presented = "small"; };
      w.presentMedium = async () => { env.presented = "medium"; };
      return w;
    },
    Keychain: {
      contains: (k) => k in env.kc, get: (k) => env.kc[k],
      set: (k, v) => { env.kc[k] = v; }, remove: (k) => { delete env.kc[k]; },
    },
    Request: function (url) {
      this.response = { statusCode: 200 };
      const answer = () => {
        env.calls.push(url);
        const hit = Object.keys(env.net).find((frag) => url.includes(frag));
        if (!hit) throw new Error("offline");
        return env.net[hit](url, this);
      };
      this.loadString = async () => answer();
      this.loadJSON = async () => answer();
    },
    FileManager: {
      local: () => ({
        joinPath: (a, b) => a + "/" + b, cacheDirectory: () => "/c", libraryDirectory: () => "/l",
        writeString: (p, s) => { env.files[p] = s; }, fileExists: (p) => p in env.files,
        readString: (p) => env.files[p], remove: (p) => { delete env.files[p]; },
      }),
    },
    Color: Object.assign(function () {}, { white: () => ({}) }),
    LinearGradient: function () {}, Font: any(), DrawContext: any(), Size: any(), Path: any(), Rect: any(),
    Device: { screenSize: () => ({ width: 393, height: 852 }) },
    DateFormatter: function () { this.string = () => (this.dateFormat === "HH:mm" ? "12:00" : "01.01 12:00"); },
    Script: { setWidget: (w) => { env.widget = w; }, complete() {}, name: () => "Marstek" },
    QuickLook: { present: async (t) => { env.presented = t; } },
    Alert: function () {
      const fields = [];
      const answer = env.alertAnswers.shift() || { choose: -1 };
      this.addTextField = (ph, text) => fields.push(text || "");
      this.addSecureTextField = (ph, text) => fields.push(text || "");
      this.addAction = () => {}; this.addCancelAction = () => {};
      const done = async () => { env.alerts.push(this.title + ": " + (this.message || "")); return answer.choose; };
      this.presentAlert = done; this.presentSheet = done;
      this.textFieldValue = (i) => (answer.fields && answer.fields[i] !== undefined ? answer.fields[i] : fields[i]);
    },
  };
  Object.assign(globalThis, g); // у Scriptable це справжні глобальні об'єкти
}

async function runScript(env, code, mode = "widget", family = "small", query) {
  install(env, mode, family, query);
  await new AsyncFunction(code)();
  return env.texts.join(" | ");
}

const device = (over) => Object.assign({ type: "VNSE3-0", devid: "dev1", name: "Venus", soc: 76, load: 0, charge: 0, discharge: 0, report_time: 1 }, over);
function marstekCloud(env, dev) {
  env.net["v2_get_device"] = () => ({ token: "new" });
  env.net["getDeviceList"] = (url) => (url.endsWith("token=new") ? { data: [typeof dev === "function" ? dev() : dev] } : { code: 8, msg: "no access" });
}

(async () => {
  // ═════════════ 1. Чиста логіка ═════════════
  const mod = { exports: {} };
  await new AsyncFunction("module", src)(mod);
  const { md5, summarize, updateHistory, estimateFromHistory, metrics, formatDuration, formatApprox, formatWatts,
    diagnosticsText, validSettings, socColorHex, CONFIG } = mod.exports;

  for (const s of ["", "a", "abc", "password123", "Пароль!їє€", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(200)]) {
    assert.strictEqual(md5(s), crypto.createHash("md5").update(s, "utf8").digest("hex"), "md5 " + s.length);
  }

  // Дані хмари мають пріоритет, якщо вони ненульові
  let r = summarize([device({ soc: "80", load: 500, discharge: 500 })], CONFIG);
  assert.strictEqual(r.mode, "discharging");
  assert.ok(Math.abs(r.hours - (5.12 * 0.68) / 0.5) < 1e-9, r.hours);
  r = summarize([device({ soc: 50, charge: 1000 })], CONFIG);
  assert.strictEqual(r.mode, "charging"); assert.ok(Math.abs(r.hours - 2.56) < 1e-9);
  r = summarize([device({ soc: 50 })], CONFIG);
  assert.strictEqual(r.mode, "idle"); assert.strictEqual(r.hours, null);
  assert.strictEqual(summarize([device({ soc: 5, load: 300, discharge: 300 })], CONFIG).hours, 0);
  r = summarize([{ type: "HME-3", soc: 0 }, device({ devid: "a", soc: 60, load: 200, discharge: 200 }), device({ devid: "b", soc: 40, load: 300, discharge: 300 })], CONFIG);
  assert.strictEqual(r.count, 2); assert.strictEqual(r.soc, 50); assert.strictEqual(r.load, 500); assert.strictEqual(r.key, "a,b");
  assert.strictEqual(summarize([], CONFIG), null);

  assert.strictEqual(formatDuration(7.066), "7 год 4 хв"); assert.strictEqual(formatDuration(0.5), "30 хв");
  assert.strictEqual(formatDuration(2), "2 год"); assert.strictEqual(formatDuration(null), "—");
  assert.strictEqual(formatApprox(36.7), "≈37 год"); assert.strictEqual(formatApprox(5.27), "≈5 год 20 хв");
  assert.strictEqual(formatApprox(0.72), "≈45 хв"); assert.strictEqual(formatApprox(null), "—");
  assert.strictEqual(formatWatts(350.4), "350 Вт"); assert.strictEqual(formatWatts(1250), "1,25 кВт");

  assert.deepStrictEqual(validSettings({ capacityKwh: "2,56", minSoc: "20", deviceName: " Venus " }), { capacityKwh: 2.56, minSoc: 20, deviceName: "Venus" });
  assert.deepStrictEqual(validSettings({ capacityKwh: "abc", minSoc: "150" }), {});
  assert.deepStrictEqual(validSettings(null), {});

  // Колір — від корисного заряду (понад резерв 12%)
  assert.strictEqual(socColorHex(90, 12), "#30d158"); assert.strictEqual(socColorHex(35, 12), "#ff9f0a");
  assert.strictEqual(socColorHex(20, 12), "#ff453a"); assert.strictEqual(socColorHex(12, 12), "#ff453a");

  const diag = diagnosticsText([{ devid: "abcdef123", sn: "SN998877", salt: "s3cr3tsalt", name: "Venus", soc: 95, load: 0 }], T0);
  assert.ok(!diag.includes("abcdef123") && !diag.includes("SN998877") && !diag.includes("s3cr3tsalt"), "ідентифікатори приховано");
  assert.ok(diag.includes('"soc": 95') && diag.includes('"name": "Venus"') && diag.includes("unix 1794000000"));

  // ═════════════ 2. Оцінка за зміною заряду ═════════════
  const toWatts = (e) => (e.pctPerHour / 100) * 5120;
  // phases: [[ват, хвилин], ...]; stepFn(k) — пауза між замірами в хвилинах
  const simulate = (phases, stepFn, startSoc = 95) => {
    let hist = null, t = T0, exact = startSoc + 0.4, k = 0;
    for (const [watts, minutes] of phases) {
      const end = t + minutes * MIN;
      while (t < end) {
        hist = updateHistory(hist, t, Math.floor(exact), "dev1");
        const step = stepFn(k++);
        exact -= (watts / 5120) * 100 * (step / 60);
        t += step * MIN;
      }
    }
    hist = updateHistory(hist, t, Math.floor(exact), "dev1");
    return { hist, est: estimateFromHistory(hist), t };
  };

  for (const [watts, steps, label] of [
    [189, () => 5, "кожні 5 хв"], [189, (k) => [7, 15, 4, 11][k % 4], "нерівномірно"],
    [1000, () => 5, "кожні 5 хв"], [60, () => 10, "кожні 10 хв"],
    [250, () => 45, "кожні 45 хв (iOS оновлює рідко)"], [250, (k) => [40, 70, 35, 55][k % 4], "паузи 35–70 хв"],
  ]) {
    const { est } = simulate([[watts, 240]], steps);
    assert.ok(est && est.pctPerHour > 0 && est.dir === "down", `є оцінка для ${watts} Вт, ${label}`);
    const err = Math.abs(toWatts(est) - watts) / watts;
    console.log(`розряд ${watts} Вт, заміри ${label} → ${Math.round(toWatts(est))} Вт (похибка ${Math.round(err * 100)}%, довіра ${est.conf})`);
    assert.ok(err < 0.3, `похибка для ${watts} Вт, ${label}: ${err}`);
  }

  // Навантаження зросло — оцінка має підтягнутися за пів години, а не усереднюватися за дві
  let sim = simulate([[200, 120], [1000, 30]], () => 5);
  console.log(`200 Вт → 1000 Вт: за 30 хв оцінка ${Math.round(toWatts(sim.est))} Вт`);
  assert.ok(toWatts(sim.est) > 800, "швидка реакція на зростання: " + toWatts(sim.est));

  // Навантаження впало — оцінка знижується, а не тримається на старій
  sim = simulate([[1000, 60], [100, 40]], () => 5);
  console.log(`1000 Вт → 100 Вт: за 40 хв оцінка ${sim.est.pctPerHour ? Math.round(toWatts(sim.est)) + " Вт" : "«<" + Math.round(toWatts({ pctPerHour: sim.est.maxPctPerHour })) + " Вт»"}`);
  assert.ok(sim.est.idle ? toWatts({ pctPerHour: sim.est.maxPctPerHour }) < 250 : toWatts(sim.est) < 250, "реакція на падіння");

  // Світло повернулося: заряд росте — одразу режим заряджання
  sim = simulate([[250, 120], [-1500, 15]], () => 5);
  assert.strictEqual(sim.est.dir, "up", "після повернення світла — заряджання");
  sim = simulate([[-800, 120]], () => 5, 40);
  assert.strictEqual(sim.est.dir, "up"); assert.ok(Math.abs(toWatts(sim.est) - 800) / 800 < 0.3);

  // Замало даних → «рахую…»; заряд довго стоїть → верхня межа навантаження
  assert.deepStrictEqual(simulate([[189, 10]], () => 5).est, { collecting: true });
  sim = simulate([[189, 120], [0, 180]], () => 5);
  assert.ok(sim.est.idle && toWatts({ pctPerHour: sim.est.maxPctPerHour }) < 30, "заряд стоїть 3 год → навантаження близько нуля");
  sim = simulate([[0, 90]], () => 5);
  assert.ok(sim.est.idle, "заряд не змінювався від початку → межа, а не «рахую»");

  // Рідкі заміри не мають хибно вмикати «навантаження зникло»
  sim = simulate([[1000, 120]], () => 15);
  assert.ok(sim.est.pctPerHour > 0 && Math.abs(toWatts(sim.est) - 1000) / 1000 < 0.3, "1 кВт при замірах раз на 15 хв");

  // Зміна станції або акаунта скидає історію; старий формат історії теж
  let h = updateHistory(null, T0, 90, "dev1");
  h = updateHistory(h, T0 + 5 * MIN, 89, "dev1");
  assert.strictEqual(h.samples.length, 2);
  assert.strictEqual(updateHistory(h, T0 + 10 * MIN, 50, "dev2").samples.length, 1, "інша станція — історія з нуля");
  assert.strictEqual(updateHistory({ samples: [{ t: 1, soc: 90, edge: true }], lastSeen: 1 }, T0, 90, "dev1").samples.length, 1, "старий формат — з нуля");
  assert.strictEqual(estimateFromHistory({ samples: [{ t: 1, soc: 90, edge: true }], lastSeen: 1 }), null);

  // Підписи у віджеті
  let m = metrics(summarize([device({ soc: 80 })], CONFIG, { pctPerHour: 4, dir: "down", conf: "ok" }), CONFIG);
  assert.deepStrictEqual([m.loadTitle, m.loadValue, m.timeValue], ["Навантаження", "≈200 Вт", "≈17 год"]);
  m = metrics(summarize([device({ soc: 80 })], CONFIG, { pctPerHour: 4, dir: "down", conf: "low" }), CONFIG);
  assert.strictEqual(m.loadTitle, "Навантаження (уточнюю)");
  m = metrics(summarize([device({ soc: 80 })], CONFIG, { collecting: true }), CONFIG);
  assert.deepStrictEqual([m.loadValue, m.timeValue], ["рахую…", "—"]);
  m = metrics(summarize([device({ soc: 80 })], CONFIG, { idle: true, maxPctPerHour: 1 }), CONFIG);
  assert.strictEqual(m.loadValue, "<60 Вт");
  m = metrics(summarize([device({ soc: 80 })], CONFIG, { idle: true, maxPctPerHour: 0.2 }), CONFIG);
  assert.strictEqual(m.loadValue, "≈0 Вт");
  m = metrics(summarize([device({ soc: 80, load: 300, discharge: 300 })], CONFIG, { pctPerHour: 4, dir: "down", conf: "ok" }), CONFIG);
  assert.deepStrictEqual([m.loadValue, m.timeValue], ["300 Вт", "11 год 36 хв"], "дані хмари мають пріоритет над оцінкою");
  m = metrics(summarize([device({ soc: 50 })], CONFIG, { pctPerHour: 20, dir: "up", conf: "ok" }), CONFIG);
  assert.deepStrictEqual([m.timeTitle, m.timeValue, m.chargeValue], ["До повного заряду", "≈2 год 30 хв", "≈1,02 кВт"]);
  console.log("логіка OK");

  // ═════════════ 3. Віджет на заглушках Scriptable ═════════════
  let env = makeEnv();
  Object.assign(env.kc, { "marstek.email": "a@b.c", "marstek.pwdhash": "h", "marstek.token": "old" });
  marstekCloud(env, device({ load: 420, discharge: 420 }));
  for (const family of ["small", "medium", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
    const out = await runScript(env, src, "widget", family);
    console.log(`віджет ${family} → ${out}`);
    assert.ok(out.includes("76%"), family);
    assert.ok(env.widget && env.widget.url === `scriptable:///run/Marstek?refresh=1&family=${family}`, "натискання оновлює без меню");
  }
  assert.strictEqual(env.kc["marstek.token"], "new", "прострочений токен оновлено");

  // Немає мережі: спершу свіжий кеш із позначкою ⚠, потім (кеш старший за 30 хв) — «немає зв'язку»
  env.net = {};
  let out = await runScript(env, src);
  assert.ok(out.includes("⚠") && out.includes("76%") && out.includes("420 Вт"), "свіжий кеш: " + out);
  const cache = JSON.parse(env.files["/c/marstek-cache.json"]);
  cache.fetchedAt -= 26 * HOUR;
  env.files["/c/marstek-cache.json"] = JSON.stringify(cache);
  out = await runScript(env, src);
  console.log("без зв'язку добу → " + out);
  assert.ok(out.includes("⚠ 01.01 12:00") && out.includes("Немає зв'язку з хмарою") && !out.includes("420 Вт"), "старий кеш: " + out);

  // Немає мережі й кешу — зрозуміле повідомлення
  delete env.files["/c/marstek-cache.json"];
  out = await runScript(env, src);
  assert.ok(out.includes("Немає зв'язку з хмарою Marstek"), out);

  // Хмара відповідає сміттям: повторний вхід не частіше ніж раз на 10 хв
  env = makeEnv();
  Object.assign(env.kc, { "marstek.email": "a@b.c", "marstek.pwdhash": "h", "marstek.token": "old" });
  env.net["v2_get_device"] = () => ({ token: "t2" });
  env.net["getDeviceList"] = () => ({ code: 500 });
  await runScript(env, src); await runScript(env, src); await runScript(env, src);
  assert.strictEqual(env.calls.filter((u) => u.includes("v2_get_device")).length, 1, "лише один повторний вхід");

  // Запуск з автоматизації «Команд»: нічого не показує, але історію поповнює
  env = makeEnv();
  Object.assign(env.kc, { "marstek.email": "a@b.c", "marstek.pwdhash": "h", "marstek.token": "new" });
  marstekCloud(env, device({ soc: 88 }));
  await runScript(env, src, "shortcut");
  assert.ok(env.widget === null && env.presented === null, "з автоматизації — без показу");
  assert.strictEqual(JSON.parse(env.files["/l/marstek-history.json"]).samples[0].soc, 88);

  // Натискання на віджет: одразу попередній перегляд потрібного розміру, без меню
  await runScript(env, src, "app", null, { refresh: "1", family: "medium" });
  assert.strictEqual(env.presented, "medium"); assert.strictEqual(env.alerts.length, 0);

  // Меню → налаштування станції: зберігаються на телефоні й впливають на розрахунок
  env.alertAnswers = [{ choose: 2 }, { choose: 0, fields: ["2,56", "20", ""] }];
  await runScript(env, src, "app");
  assert.deepStrictEqual(JSON.parse(env.files["/l/marstek-settings.json"]), { capacityKwh: 2.56, minSoc: 20, deviceName: "" });
  env.alertAnswers = [{ choose: 2 }, { choose: 0, fields: ["нуль", "20", ""] }, { choose: 0 }];
  await runScript(env, src, "app");
  assert.strictEqual(JSON.parse(env.files["/l/marstek-settings.json"]).capacityKwh, 2.56, "хибні значення не зберігаються");
  assert.ok(env.alerts.some((a) => a.startsWith("Не збережено")));

  // Перший вхід: хибний пароль не зберігається, правильний — зберігається
  env = makeEnv();
  env.net["v2_get_device"] = (url) => (url.includes(md5("good")) ? { token: "tok" } : { code: 0, msg: "bad" });
  env.net["getDeviceList"] = () => ({ data: [device()] });
  env.alertAnswers = [{ choose: 0, fields: ["a@b.c", "wrong"] }, { choose: 0 }];
  await runScript(env, src, "app");
  assert.ok(!("marstek.email" in env.kc) && env.alerts.some((a) => a.includes("Невірний email або пароль")), "хибний пароль відхилено");
  env.alertAnswers = [{ choose: 0, fields: ["a@b.c", "good"] }];
  out = await runScript(env, src, "app");
  assert.ok(env.kc["marstek.pwdhash"] === md5("good") && out.includes("76%") && env.presented === "small");
  console.log("віджет OK");

  // ═════════════ 4. Завантажувач ═════════════
  const KEY = "ABCD2345EFGH6789";
  const sign = (code) => crypto.createHmac("sha256", KEY).update(code, "utf8").digest("hex");
  const github = (env, code, sig) => {
    env.net["Marstek.js.sig"] = () => sig + "\n";
    env.net["main/Marstek.js"] = () => code;
  };
  const githubCalls = (env) => env.calls.filter((u) => u.includes("githubusercontent")).length;
  const newEnv = () => {
    const e = makeEnv();
    Object.assign(e.kc, { "marstek.email": "a@b.c", "marstek.pwdhash": "h", "marstek.token": "new", "marstek.signkey": KEY });
    marstekCloud(e, device({ load: 420, discharge: 420 }));
    return e;
  };

  // Перше встановлення: підпис збігається → код запускається і зберігається
  env = newEnv();
  github(env, src, sign(src));
  out = await runScript(env, loader);
  assert.ok(out.includes("76%"), "завантажувач запустив віджет: " + out);
  assert.strictEqual(env.files["/l/marstek-code.js"], src);
  assert.strictEqual(JSON.parse(env.files["/l/marstek-loader.json"]).sig, sign(src));

  // Наступний запуск віджета: GitHub не чіпаємо (перевірка раз на пів години)
  let before = githubCalls(env);
  out = await runScript(env, loader);
  assert.ok(out.includes("76%")); assert.strictEqual(githubCalls(env), before, "без зайвих запитів до GitHub");

  // Минуло пів години, версія та сама: качаємо лише маленький файл підпису
  const forceCheck = (e) => { const mt = JSON.parse(e.files["/l/marstek-loader.json"]); mt.checkedAt = 0; e.files["/l/marstek-loader.json"] = JSON.stringify(mt); };
  forceCheck(env); before = githubCalls(env);
  await runScript(env, loader);
  assert.strictEqual(githubCalls(env) - before, 1, "лише перевірка підпису");

  // Нова версія зламана → відкат до попередньої, зламана більше не пробується
  const broken = "throw new Error('boom');";
  github(env, broken, sign(broken)); forceCheck(env);
  out = await runScript(env, loader);
  assert.ok(out.includes("76%"), "після зламаного оновлення працює попередня версія: " + out);
  assert.strictEqual(env.files["/l/marstek-code.js"], src, "збережений код не перезаписано");
  let meta = JSON.parse(env.files["/l/marstek-loader.json"]);
  assert.strictEqual(meta.rejected, sign(broken)); assert.ok(meta.rejectedError.includes("boom"));
  forceCheck(env); before = githubCalls(env);
  await runScript(env, loader);
  assert.strictEqual(githubCalls(env) - before, 1, "зламану версію вдруге не качаємо");

  // Синтаксична помилка в новій версії → теж відкат
  const garbage = "this is not javascript {";
  github(env, garbage, sign(garbage)); forceCheck(env);
  assert.ok((await runScript(env, loader)).includes("76%"), "синтаксична помилка → попередня версія");

  // Код без правильного підпису (чужий або підмінений) не запускається
  const evil = "Script.setWidget({ evil: true });";
  github(env, evil, crypto.createHmac("sha256", "WRONGKEY").update(evil).digest("hex")); forceCheck(env);
  out = await runScript(env, loader);
  assert.ok(out.includes("76%") && !(env.widget && env.widget.evil), "непідписаний код не виконано");
  assert.strictEqual(env.files["/l/marstek-code.js"], src);

  // Справна нова версія → стає основною
  const v2 = src + "\n// v2\n";
  github(env, v2, sign(v2)); forceCheck(env);
  assert.ok((await runScript(env, loader)).includes("76%"));
  assert.strictEqual(env.files["/l/marstek-code.js"], v2, "нова версія збережена");

  // Немає інтернету → збережена версія
  env.net = {}; marstekCloud(env, device({ load: 420, discharge: 420 })); forceCheck(env);
  assert.ok((await runScript(env, loader)).includes("76%"), "без GitHub працює збережена версія");

  // Немає коду підпису: у віджеті — підказка, у Scriptable — запит коду
  env = newEnv(); delete env.kc["marstek.signkey"]; github(env, src, sign(src));
  out = await runScript(env, loader);
  assert.ok(out.includes("завершити налаштування") && githubCalls(env) === 0, out);
  env.alertAnswers = [{ choose: 0, fields: ["abcd-2345-efgh-6789"] }, { choose: 0 }];
  out = await runScript(env, loader, "app");
  assert.strictEqual(env.kc["marstek.signkey"], KEY, "код нормалізується");
  assert.ok(out.includes("76%"), "після введення коду віджет запускається: " + out);

  // Хибний код підпису при першому встановленні → нічого не запускається, код просять ще раз
  env = newEnv(); env.kc["marstek.signkey"] = "WRONG"; github(env, src, sign(src));
  out = await runScript(env, loader);
  assert.ok(out.includes("Код підпису не підійшов") && !("/l/marstek-code.js" in env.files), out);
  console.log("завантажувач OK");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
