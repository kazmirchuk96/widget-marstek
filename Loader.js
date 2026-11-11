// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: battery-half;

// Завантажувач віджета Marstek. Вставляється в Scriptable один раз.
// При кожному запуску бере найновішу версію віджета з GitHub;
// якщо інтернету немає — запускає останню збережену.
const SOURCE = "https://raw.githubusercontent.com/kazmirchuk96/widget-marstek/main/Marstek.js";

const fm = FileManager.local();
const saved = fm.joinPath(fm.libraryDirectory(), "marstek-widget-code.js");

let code = null;
try {
  const req = new Request(SOURCE);
  req.timeoutInterval = 10;
  const text = await req.loadString();
  if (req.response.statusCode === 200 && text.includes("API_DEVICES")) {
    code = text;
    fm.writeString(saved, code);
  }
} catch (e) {
  // немає мережі — нижче візьмемо збережену версію
}
if (code === null && fm.fileExists(saved)) code = fm.readString(saved);

if (code === null) {
  const w = new ListWidget();
  w.addText("Marstek: не вдалося завантажити віджет. Перевірте інтернет.").font = Font.systemFont(13);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentSmall();
  Script.complete();
} else {
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction(code)();
}
