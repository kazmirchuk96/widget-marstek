#!/bin/sh
# Заливка віджета на GitHub — звідти iPhone сам бере найновішу версію (див. Loader.js).
#
#   ./deploy.sh prepare   перед комітом: тести + підпис Marstek.js (хук pre-commit)
#   ./deploy.sh push      після коміту: git push (хук post-commit)
#   ./deploy.sh           обидва кроки вручну (підпис треба закомітити самому)
#
# Підпис: HMAC-SHA256 від Marstek.js з ключем із файлу .signing-key (не потрапляє в git).
# Той самий ключ введено на iPhone; завантажувач не запустить код без правильного підпису.
set -e
cd "$(dirname "$0")"

prepare() {
  if ! node test/test.js >/dev/null 2>&1; then
    echo "deploy: тести не пройшли — коміт скасовано. Запустіть: node test/test.js"
    exit 1
  fi
  if [ ! -s .signing-key ]; then
    echo "deploy: немає файлу .signing-key — підписати оновлення нічим"
    exit 1
  fi
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const key = fs.readFileSync(".signing-key", "utf8").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const sig = crypto.createHmac("sha256", key).update(fs.readFileSync("Marstek.js")).digest("hex");
    fs.writeFileSync("Marstek.js.sig", sig + "\n");
  '
  git add Marstek.js.sig
}

push() {
  if git push -q origin main; then
    echo "deploy: залито на GitHub — iPhone підхопить нову версію протягом пів години (або одразу при запуску в Scriptable)"
  else
    echo "deploy: не вдалося залити на GitHub"
    exit 1
  fi
}

case "${1:-all}" in
  prepare) prepare ;;
  push) push ;;
  all) prepare; push ;;
  *) echo "deploy: невідома команда $1"; exit 1 ;;
esac
