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

python3 - "$VERSION" "$HASH" "$REPO" <<'PY'
import json, sys
version, hash_, repo = sys.argv[1], sys.argv[2], sys.argv[3]
data = {
  "addons": {
    "annota@equiriconi": {
      "updates": [{
        "version": version,
        "update_link": f"https://github.com/{repo}/releases/download/v{version}/annota.xpi",
        "update_hash": "sha256:" + hash_,
        "applications": {
          "zotero": {"strict_min_version": "7.0", "strict_max_version": "9.*"}
        }
      }]
    }
  }
}
with open("updates.json", "w") as f:
    f.write(json.dumps(data, indent=2) + "\n")
print("→ updates.json mis à jour")
PY

git add manifest.json updates.json
git commit -m "Release ${TAG}" || echo "(rien à committer)"
git push origin main

echo "→ Création de la release GitHub ${TAG}"
gh release create "$TAG" annota.xpi --title "Annota ${TAG}" --generate-notes

echo
echo "✓ ${TAG} publiée. Les installations existantes se mettront à jour"
echo "  automatiquement (Zotero vérifie périodiquement, ou via Modules"
echo "  complémentaires → ⚙️ → Check for Updates)."
