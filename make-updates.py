#!/usr/bin/env python3
# Régénère updates.json pour une version publiée en release GitHub.
# Usage : make-updates.py VERSION SHA256 OWNER/REPO
# Partagé par release.sh (publication locale) et .github/workflows/release.yml.
import json, sys
version, hash_, repo = sys.argv[1], sys.argv[2], sys.argv[3]

# Bornes de compatibilité lues DANS le manifeste : les recopier ici, c'est se
# condamner à les oublier le jour où Zotero change de version majeure.
zot = json.load(open("manifest.json"))["applications"]["zotero"]
bounds = {k: zot[k] for k in ("strict_min_version", "strict_max_version") if k in zot}
data = {
  "addons": {
    "annota@equiriconi": {
      "updates": [{
        "version": version,
        "update_link": f"https://github.com/{repo}/releases/download/v{version}/annota.xpi",
        "update_hash": "sha256:" + hash_,
        "applications": {"zotero": bounds}
      }]
    }
  }
}
with open("updates.json", "w") as f:
    f.write(json.dumps(data, indent=2) + "\n")
print("→ updates.json mis à jour")
