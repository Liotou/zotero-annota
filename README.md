# Annota (Zotero 7 / 8 / 9)

**Annota automatise un prompt sur chaque surlignage : le texte que vous
surlignez dans le lecteur PDF est envoyé à un LLM, et la réponse devient le
commentaire de l'annotation** — à la volée, dès la création du surlignage.

Le prompt est entièrement à vous. Résumé, explication, traduction, extraction
de points clés, note académique formatée… vous décidez de ce que produit le
modèle. Des **modèles prédéfinis** sont fournis pour démarrer, et fonctionnent
avec Mistral (par défaut) ou tout endpoint compatible OpenAI.

### Exemple : le modèle « Note académique » (fourni par défaut)

```
<b>Titre.</b>
Paraphrase concise (2 à 5 phrases, ~80 mots max).
<i>(Auteur, année, p.XX ; Auteur2, année)</i>
```

La 3ᵉ ligne (références) n'apparaît que si le passage cite explicitement des
sources ; un numéro de page présent dans le passage (« Moulin, 1999, p.93 ») est
repris tel quel. Ce n'est qu'un modèle : remplacez-le par le vôtre à tout moment.

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

Vous pouvez aussi télécharger le `.xpi` directement depuis la page
[Releases](../../releases).

## Configuration

**Modules complémentaires → Annota**, ou **Préférences → Annota** :

### Général
- **Activer la génération automatique** — coupe/active tout le plugin.
- **Traiter aussi les soulignements** — par défaut, seuls les surlignages
  (`highlight`) déclenchent la génération ; cette case ajoute `underline`.
- **Écraser un commentaire déjà présent** — désactivé par défaut.
- **⏳ pendant la génération** — indicateur affiché le temps de l'appel réseau.

### Connexion à l'API
- **Clé API** — Mistral par défaut (obtenez-la sur https://console.mistral.ai).
- **Modèle** — `mistral-large-latest` par défaut.
- **Endpoint** — URL de l'API (chat/completions, compatible OpenAI). Modifiable
  pour un proxy ou un autre fournisseur compatible.
- **Température** — 0 à 2 ; plus bas = plus déterministe (défaut 0.2).

### Génération du texte
- **Langue de sortie** — disponible dans le prompt via `{{language}}`.
- **Longueur max.** — disponible via `{{maxWords}}`.

### Prompt
Le champ de prompt est le cœur d'Annota. Un menu **« Insérer un modèle »**
propose des points de départ (note académique, résumé, explication simple,
points clés, traduction) ; sélectionner un modèle remplit le champ, que vous
pouvez ensuite modifier librement. **« Restaurer le modèle par défaut »** revient
au modèle académique.

**Variables** remplacées au moment de l'appel :

| Variable | Contenu |
|---|---|
| `{{text}}` | le texte surligné |
| `{{title}}` | titre du document source |
| `{{authors}}` | auteurs du document source |
| `{{year}}` | année du document source |
| `{{maxWords}}` | réglage « longueur max » |
| `{{language}}` | réglage « langue de sortie » |

Deux modes selon le prompt :
- **Standard** (pas de `{{text}}`) — votre prompt sert d'instructions, et le texte
  surligné est ajouté automatiquement comme message utilisateur.
- **Avancé** (le prompt contient `{{text}}`) — le prompt est envoyé tel quel, vous
  contrôlez intégralement la structure de la requête.

## Fonctionnement

- Écoute l'événement `add` du notifier Zotero sur les items de type annotation.
- Ne traite que `annotationType` = `highlight` (+ `underline` si activé), avec
  un texte non vide.
- Envoie le texte au prompt configuré, puis écrit la réponse dans
  `annotationComment`. Le lecteur se met à jour seul.
- Écrire le commentaire déclenche un événement `modify` (pas `add`), donc pas de
  boucle. Une annotation déjà commentée (y compris synchronisée depuis un autre
  appareil) n'est pas régénérée.

## Sécurité

La clé API est stockée **en clair** dans les préférences du profil Zotero
(`extensions.zotero.annota.apiKey`). Ne partagez pas votre profil.

## Développement

- Modèles de prompts et prompt par défaut : `bootstrap.js` → `Annota.PRESETS`.
- Déclenchement / filtrage des annotations : `bootstrap.js` → `handleItem()`.
- Construction de la requête (variables, modes) : `bootstrap.js` → `buildMessages()`.
