// Préférences par défaut (branche extensions.zotero.annota.*)

// ---- Fournisseur ----
// "openai" = Mistral ou tout endpoint compatible OpenAI (distant)
// "ollama" = modèle local via Ollama
// "cli"    = Claude Code CLI local
pref("extensions.zotero.annota.provider", "openai");

// Compatible OpenAI (Mistral par défaut).
pref("extensions.zotero.annota.apiKey", "");
pref("extensions.zotero.annota.model", "mistral-large-latest");
pref("extensions.zotero.annota.endpoint", "https://api.mistral.ai/v1/chat/completions");

// Ollama (local, aucune clé requise).
pref("extensions.zotero.annota.ollamaEndpoint", "http://localhost:11434/v1/chat/completions");
pref("extensions.zotero.annota.ollamaModel", "llama3.1");

// Claude Code CLI (local).
pref("extensions.zotero.annota.cliPath", "claude");
pref("extensions.zotero.annota.cliModel", "");

pref("extensions.zotero.annota.temperature", "0.2");

// ---- Sortie ----
pref("extensions.zotero.annota.language", "français");
pref("extensions.zotero.annota.maxWords", 80);

// ---- Contexte transmis ----
pref("extensions.zotero.annota.sendContext", true);
pref("extensions.zotero.annota.maxAbstractChars", 1200);
// Résoudre les appels de citation du passage ([1], (Auteur, année)) : liens
// internes du PDF d'abord, bibliographie extraite du texte en repli.
pref("extensions.zotero.annota.resolveCitations", true);
pref("extensions.zotero.annota.maxRefs", 8);

// ---- Déclenchement ----
pref("extensions.zotero.annota.alsoUnderline", false);
pref("extensions.zotero.annota.overwrite", false);
pref("extensions.zotero.annota.showPlaceholder", true);

// ---- Index bibliographique ----
// Format de chaque ligne de la note d'index. Variables : {{key}} (« Auteur,
// année »), {{entry}} (entrée complète), {{doi}}, {{marker}}, {{pages}}.
pref("extensions.zotero.annota.indexLineFormat", "[[{{key}}]] — {{entry}}");

// ---- Couleurs ----
// JSON { "#ffd400": { prompt, trigger, template }, … }.
// Vide par défaut : aucune couleur n'est traitée tant que rien n'est configuré.
pref("extensions.zotero.annota.colorPrompts", "");
