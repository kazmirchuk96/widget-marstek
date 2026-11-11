#!/bin/sh
# Копіює Marstek.js у теку Scriptable в iCloud Drive — звідти він сам потрапляє на iPhone.
# Запускається автоматично після кожного коміту (git-хук post-commit) або вручну: ./deploy.sh
set -e
cd "$(dirname "$0")"

DEST="$HOME/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents"

if [ ! -d "$DEST" ]; then
  echo "deploy: теки Scriptable в iCloud Drive ще немає — встановіть Scriptable на iPhone і відкрийте його один раз. Файл не скопійовано."
  exit 0
fi

if ! node test/test.js >/dev/null 2>&1; then
  echo "deploy: тести не пройшли — файл на iPhone НЕ оновлено. Запустіть: node test/test.js"
  exit 1
fi

cp Marstek.js "$DEST/Marstek.js"
echo "deploy: Marstek.js скопійовано в iCloud Drive → Scriptable"
