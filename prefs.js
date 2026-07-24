// Préférences par défaut (branche extensions.zotero.annota.*)
// Fournisseur : false = Mistral/compatible OpenAI, true = Claude Code CLI local.
pref("extensions.zotero.annota.useClaudeCLI", false);
pref("extensions.zotero.annota.cliPath", "claude");
pref("extensions.zotero.annota.cliModel", "");
// Fournisseur compatible OpenAI (Mistral par défaut).
pref("extensions.zotero.annota.apiKey", "");
pref("extensions.zotero.annota.model", "mistral-large-latest");
pref("extensions.zotero.annota.endpoint", "https://api.mistral.ai/v1/chat/completions");
pref("extensions.zotero.annota.enabled", true);
pref("extensions.zotero.annota.overwrite", false);
pref("extensions.zotero.annota.showPlaceholder", true);
pref("extensions.zotero.annota.alsoUnderline", false);
pref("extensions.zotero.annota.maxWords", 80);
// Transmettre le contexte du document (titre, auteurs, année, revue, résumé, page).
pref("extensions.zotero.annota.sendContext", true);
pref("extensions.zotero.annota.maxAbstractChars", 1200);
pref("extensions.zotero.annota.language", "français");
pref("extensions.zotero.annota.temperature", "0.2");
// JSON { "#ffd400": "prompt…", … } : le prompt de chaque couleur.
// Vide par défaut : aucune couleur n'est traitée tant que rien n'est configuré.
pref("extensions.zotero.annota.colorPrompts", "");
