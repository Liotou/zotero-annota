#!/usr/bin/env bash
# Construit le fichier .xpi installable dans Zotero.
set -euo pipefail
cd "$(dirname "$0")"

OUT="annota.xpi"
rm -f "$OUT"

# On zippe le CONTENU du dossier (les fichiers doivent être à la racine du zip),
# pas le dossier lui-même.
zip -r -X "$OUT" \
    manifest.json \
    bootstrap.js \
    prefs.js \
    preferences.xhtml \
    preferences.js \
    preferences.css \
    icon32.png \
    icon48.png \
    icon96.png \
    -x "*.DS_Store"

echo "OK -> $(pwd)/$OUT"
echo "Installer : Zotero → Outils → Modules complémentaires → engrenage → Install Add-on From File…"
