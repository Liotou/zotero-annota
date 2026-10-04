#!/usr/bin/env bash
# Publie une nouvelle version : build, empreinte, updates.json, tag, release GitHub.
#
# Usage :
#   1. Mettre à jour "version" dans manifest.json
#   2. ./release.sh
#
# Le hash SHA-256 de updates.json DOIT correspondre au .xpi de la release,
# sinon Zotero refuse la mise à jour. Ce script garantit cette cohérence.
set -euo pipefail
cd "$(dirname "$0")"

REPO="Liotou/zotero-annota"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Erreur : le tag $TAG existe déjà. Bumpez 'version' dans manifest.json." >&2
  exit 1
fi

echo "→ Construction de la version ${VERSION}"
./build.sh >/dev/null

HASH=$(shasum -a 256 annota.xpi | cut -d' ' -f1)
echo "→ SHA-256 : ${HASH}"

python3 make-updates.py "$VERSION" "$HASH" "$REPO"

git add manifest.json updates.json
git commit -m "Release ${TAG}" || echo "(rien à committer)"
git push origin main

echo "→ Création de la release GitHub ${TAG}"
gh release create "$TAG" annota.xpi --title "Annota ${TAG}" --generate-notes

echo
echo "✓ ${TAG} publiée. Les installations existantes se mettront à jour"
echo "  automatiquement (Zotero vérifie périodiquement, ou via Modules"
echo "  complémentaires → ⚙️ → Check for Updates)."
