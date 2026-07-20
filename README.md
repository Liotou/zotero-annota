# Annota (Zotero 7 / 8 / 9)

Quand vous créez un **surlignage** dans le lecteur PDF de Zotero, l'extension
remplit automatiquement le **commentaire** de l'annotation avec une note
formatée générée par une **API LLM** (Mistral Large par défaut, ou tout
endpoint compatible OpenAI) :

```
<b>Titre.</b>
Paraphrase concise (2 à 5 phrases, ~80 mots max).
<i>(Auteur, année, p.XX ; Auteur2, année)</i>
```

La 3ᵉ ligne (références) n'apparaît **que si** le passage surligné cite
explicitement des sources. Sinon elle est omise. Si un numéro de page
apparaît dans le passage à côté d'une citation (ex. « Moulin, 1999, p.93 »),
il est repris tel quel dans la référence.

## Installation

1. Construire le paquet :
   ```bash
   ./build.sh
   ```
   (ou zippez `manifest.json`, `bootstrap.js`, `prefs.js`, `preferences.xhtml`,
   `preferences.js` à la racine d'un `.zip`, puis renommez-le en `.xpi`).
2. Zotero → **Outils → Modules complémentaires** → engrenage ⚙️ →
   **Install Add-on From File…** → choisir `annota.xpi`.
3. Redémarrer Zotero si demandé.

## Configuration

**Modules complémentaires → Annota**, ou
**Préférences → Annota** :

### Général
- **Activer la génération automatique** — coupe/active tout le plugin.
- **Traiter aussi les soulignements** — par défaut, seuls les surlignages
  (`highlight`) déclenchent la génération ; cette case ajoute `underline`.
- **Écraser un commentaire déjà présent** — désactivé par défaut (les
  annotations déjà commentées ne sont jamais retouchées).
- **⏳ pendant la génération** — affiche un indicateur le temps de l'appel réseau.

### Connexion à l'API
- **Clé API Mistral** — obtenez-la sur https://console.mistral.ai
- **Modèle** — `mistral-large-latest` par défaut.
- **Endpoint** — URL de l'API (chat/completions, compatible OpenAI). Modifiable
  si vous passez par un proxy ou un autre fournisseur compatible.
- **Température** — 0 à 2 ; plus bas = plus déterministe (défaut 0.2).

### Génération du texte
- **Langue de sortie** — injectée dans le prompt via `{{language}}`.
- **Longueur max. de la paraphrase** — injectée via `{{maxWords}}`.

### Prompt système
Le prompt complet envoyé à l'API est **entièrement éditable** dans un champ de
texte. Deux jetons sont substitués automatiquement au moment de l'appel :
`{{maxWords}}` et `{{language}}` (valeurs des réglages ci-dessus). Laisser le
champ vide revient à utiliser le prompt par défaut intégré à l'extension.
Le bouton **« Réinitialiser au prompt par défaut »** efface votre version et
recharge l'original.

## Fonctionnement

- Écoute l'événement `add` du notifier Zotero sur les items de type annotation.
- Ne traite que `annotationType` = `highlight` (+ `underline` si activé), avec
  un texte non vide.
- Envoie le texte au prompt configuré, applique le format cible, puis écrit le
  résultat dans `annotationComment`. Le lecteur se met à jour seul.
- Écrire le commentaire déclenche un événement `modify` (pas `add`), donc pas
  de boucle. La génération synchronisée depuis un autre appareil n'est pas
  regénérée (le commentaire est déjà présent).

## Sécurité

La clé API est stockée **en clair** dans les préférences du profil Zotero
(`extensions.zotero.annota.apiKey`). Ne partagez pas votre profil.

## Notes / limites

- Le prompt par défaut est dans `bootstrap.js` → `Annota.DEFAULT_PROMPT`
  (utilisé si le champ de préférences est vide ou après un reset).
- La logique de déclenchement/filtrage des annotations est dans
  `bootstrap.js` → `handleItem()`.
