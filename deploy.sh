#!/bin/sh
# Заливає віджет на GitHub — звідти iPhone сам бере найновішу версію (див. Loader.js).
# Запускається автоматично після кожного коміту (git-хук post-commit) або вручну: ./deploy.sh
set -e
cd "$(dirname "$0")"

if ! node test/test.js >/dev/null 2>&1; then
  echo "deploy: тести не пройшли — на GitHub НЕ залито. Запустіть: node test/test.js"
  exit 1
fi

if git push -q origin main; then
  echo "deploy: залито на GitHub — iPhone підхопить нову версію при наступному оновленні віджета"
else
  echo "deploy: не вдалося залити на GitHub"
  exit 1
fi
