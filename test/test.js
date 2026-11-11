const fs = require("fs"), crypto = require("crypto"), assert = require("assert");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "Marstek.js"), "utf8");
const loader = fs.readFileSync(path.join(__dirname, "..", "Loader.js"), "utf8");
const AsyncFunction = (async () => {}).constructor;
(async () => {
  // 1) pure logic
  const mod = { exports: {} };
  await new AsyncFunction("module", src)(mod);
  const { md5, summarize, formatDuration, formatWatts, diagnosticsText, CONFIG } = mod.exports;
  for (const s of ["", "a", "abc", "password123", "Пароль!їє€", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(200)])
    assert.strictEqual(md5(s), crypto.createHash("md5").update(s, "utf8").digest("hex"), "md5 " + s.length);
  let r = summarize([{ soc: "80", load: 500, charge: 0, discharge: 500, report_time: 1794000000 }], CONFIG);
  assert.strictEqual(r.mode, "discharging");
  assert.ok(Math.abs(r.hours - 5.12 * 0.68 / 0.5) < 1e-9, r.hours);
  r = summarize([{ soc: 50, load: 0, charge: 1000, discharge: 0 }], CONFIG);
  assert.strictEqual(r.mode, "charging"); assert.ok(Math.abs(r.hours - 2.56) < 1e-9);
  r = summarize([{ soc: 50, load: 0, charge: 0, discharge: 0 }], CONFIG);
  assert.strictEqual(r.mode, "idle"); assert.strictEqual(r.hours, null);
  r = summarize([{ soc: 5, load: 300, discharge: 300 }], CONFIG); assert.strictEqual(r.hours, 0);
  r = summarize([{ type: "HME-3", soc: 0 }, { soc: 60, load: 200, discharge: 200 }, { soc: 40, load: 300, discharge: 300 }], CONFIG);
  assert.strictEqual(r.count, 2); assert.strictEqual(r.soc, 50); assert.strictEqual(r.load, 500);
  assert.strictEqual(summarize([], CONFIG), null);
  assert.strictEqual(formatDuration(7.066), "7 год 4 хв"); assert.strictEqual(formatDuration(0.5), "30 хв");
  assert.strictEqual(formatDuration(2), "2 год"); assert.strictEqual(formatDuration(null), "—");
  assert.strictEqual(formatWatts(350.4), "350 Вт"); assert.strictEqual(formatWatts(1250), "1,25 кВт");
  const diag = diagnosticsText([{ devid: "abcdef123", sn: "SN998877", name: "Venus", soc: 95, load: 0 }], 1794000000000);
  assert.ok(!diag.includes("abcdef123") && !diag.includes("SN998877"), "ідентифікатори приховано");
  assert.ok(diag.includes('"soc": 95') && diag.includes('"name": "Venus"') && diag.includes("unix 1794000000"));
  console.log("logic OK");

  // 2) full run with Scriptable stubs
  const texts = [];
  const any = () => new Proxy(function () {}, { get: (t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : any()), set: () => true, apply: () => any(), construct: () => any() });
  const stack = () => ({ addText: (s) => (texts.push(s), {}), addStack: stack, addSpacer() {}, addImage: () => ({}), layoutVertically() {}, centerAlignContent() {}, bottomAlignContent() {}, setPadding() {} });
  const kc = { "marstek.email": "a@b.c", "marstek.pwdhash": "h", "marstek.token": "old" };
  const files = {}; const calls = [];
  for (const [label, code] of [["віджет", src], ["завантажувач", loader], ["завантажувач без мережі", loader]])
  for (const family of ["small", "medium", "accessoryRectangular"]) {
    texts.length = 0;
    const g = {
      module: {}, config: { runsInWidget: true, runsInApp: false, widgetFamily: family },
      ListWidget: function () { return stack(); },
      Keychain: { contains: (k) => k in kc, get: (k) => kc[k], set: (k, v) => (kc[k] = v), remove: (k) => delete kc[k] },
      Request: function (url) { this.response = { statusCode: 200 };
        this.loadString = async () => { if (label.includes("без мережі")) throw new Error("offline"); return src; };
        this.loadJSON = async () => { calls.push(url);
        if (url.includes("v2_get_device")) return { token: "new" };
        return url.endsWith("token=new") ? { data: [{ type: "HMG-50", name: "Venus", soc: 76, load: 420, charge: 0, discharge: 420, report_time: 1794000000 }] } : { code: 8, msg: "no access" }; }; },
      FileManager: { local: () => ({ joinPath: (a, b) => a + "/" + b, cacheDirectory: () => "/c", libraryDirectory: () => "/l", writeString: (p, s) => (files[p] = s), fileExists: (p) => p in files, readString: (p) => files[p] }) },
      Color: Object.assign(function () {}, { white: () => ({}) }), LinearGradient: function () {}, Font: any(), DrawContext: any(), Size: any(), Path: any(), Rect: any(),
      DateFormatter: function () { this.string = () => "12:00"; }, Script: { setWidget() {}, complete() {} }, Alert: any(),
    };
    Object.assign(globalThis, g); // у Scriptable це справжні глобальні об'єкти
    await new AsyncFunction(code)();
    assert.ok(texts.includes("76%") || texts[0].includes("76%"), label + " " + family);
    console.log(label, family, "→", texts.join(" | "));
  }
  console.log("requests:", calls.map((u) => u.replace(/https:\/\/[^/]+/, "")).join("  "));
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
