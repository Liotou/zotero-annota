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

// Apple Intelligence (local, macOS 26+). Binaire compilé à la demande ;
// laisser vide pour utiliser celui géré par Annota.
pref("extensions.zotero.annota.applePath", "");
pref("extensions.zotero.annota.swiftcPath", "/usr/bin/swiftc");

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

// ---- Échecs ----
// Une génération ratée laissait un surlignage sans commentaire, silencieusement.
// On réessaie, puis on marque l'annotation d'une étiquette pour pouvoir la
// retrouver et la rejouer.
pref("extensions.zotero.annota.retries", 1);
pref("extensions.zotero.annota.markFailures", true);
pref("extensions.zotero.annota.failedTag", "annota-failed");

// Sortie structurée (JSON) pour le remplissage des champs, quand le
// fournisseur la gère : Mistral/OpenAI et Ollama. Repli automatique sur la
// lecture « nom: valeur » si la réponse n'est pas du JSON exploitable.
pref("extensions.zotero.annota.structuredOutput", true);

// ---- Déclenchement ----
pref("extensions.zotero.annota.alsoUnderline", false);
pref("extensions.zotero.annota.overwrite", false);
pref("extensions.zotero.annota.showPlaceholder", true);

// ---- Couleurs ----
// JSON { "#ffd400": { prompt, trigger, template }, … }.
// Vide par défaut : aucune couleur n'est traitée tant que rien n'est configuré.
pref("extensions.zotero.annota.colorPrompts", "");
