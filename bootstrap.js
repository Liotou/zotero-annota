/* eslint-disable no-undef */
// Annota — extension Zotero 7
// Remplit le commentaire d'un surlignage à sa création, via l'API Mistral Large.

var Annota;

const PREF_BRANCH = "annota.";

function getPref(key, fallback) {
	let val = Zotero.Prefs.get(PREF_BRANCH + key);
	return (val === undefined || val === null) ? fallback : val;
}

function log(msg) {
	Zotero.debug("[Annota] " + msg);
}

function toast(title, body, type = "default") {
	try {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(title);
		if (body) {
			let icon = type === "error"
				? "chrome://zotero/skin/cross.png"
				: "chrome://zotero/skin/tick.png";
			pw.addLines([body], [icon]);
		}
		pw.show();
		pw.startCloseTimer(type === "error" ? 6000 : 2500);
	}
	catch (e) {
		log("toast failed: " + e);
	}
}

Annota = {
	id: null,
	version: null,
	rootURI: null,
	notifierID: null,
	inProgress: new Set(),

	// Prompt par défaut. Éditable dans les préférences.
	// Jetons substitués à l'exécution : {{maxWords}}, {{language}}.
	DEFAULT_PROMPT: [
		"Tu es un assistant qui transforme un passage surligné d'un article académique",
		"en une note structurée, prête à coller dans un commentaire d'annotation Zotero.",
		"",
		"Réponds EXACTEMENT dans ce format, et rien d'autre :",
		"",
		"<b>Titre.</b>",
		"Paraphrase concise.",
		"<i>(Auteur, année, p.XX ; Auteur2, année)</i>",
		"",
		"Règles impératives :",
		"- Le titre fait 3 à 8 mots, synthétise l'idée centrale du passage, et se termine",
		"  par un point PLACÉ À L'INTÉRIEUR des balises <b>…</b>.",
		"- La paraphrase reformule le passage avec tes propres mots : 2 à 5 phrases,",
		"  {{maxWords}} mots maximum, fidèle au sens, sans ajout d'information.",
		"- La ligne de références n'apparaît QUE si le passage cite explicitement une ou",
		"  plusieurs sources (nom d'auteur + année présents dans le texte surligné).",
		"  Format : <i>(Auteur, année ; Auteur2, année)</i>, séparateur « ; ».",
		"  Intègre le numéro de page S'IL apparaît dans le passage, placé juste après",
		"  l'année sous la forme « , p.XX » — par ex. (Moulin, 1999, p.93 ; Jacques, 2009).",
		"  Conserve la notation des pages telle qu'écrite (p., pp., plage « p.12-15 »).",
		"  N'ajoute jamais de numéro de page qui n'est pas dans le passage.",
		"- N'invente jamais de référence, et ne cite pas l'article source lui-même.",
		"- Réponds en {{language}}.",
		"- N'utilise QUE les balises <b> et <i>. Aucune balise Markdown, aucun bloc de code,",
		"  aucun texte d'introduction ou d'explication.",
	].join("\n"),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	registerNotifier() {
		this.notifierID = Zotero.Notifier.registerObserver(
			this.notifierCallback,
			["item"],
			"annota"
		);
		log("Notifier enregistré (id=" + this.notifierID + ")");
	},

	unregisterNotifier() {
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
	},

	notifierCallback: {
		notify(event, type, ids, _extraData) {
			// On ne réagit qu'à la CRÉATION d'items.
			if (event !== "add" || type !== "item") return;
			if (!getPref("enabled", true)) return;
			for (let id of ids) {
				// fire-and-forget : ne pas bloquer la transaction Zotero
				Annota.handleItem(id).catch(e => log("handleItem: " + e));
			}
		}
	},

	targetTypes() {
		let types = ["highlight"];
		if (getPref("alsoUnderline", false)) types.push("underline");
		return types;
	},

	async handleItem(id) {
		if (this.inProgress.has(id)) return;

		let item;
		try {
			item = await Zotero.Items.getAsync(id);
		}
		catch (e) {
			return;
		}
		if (!item || !item.isAnnotation || !item.isAnnotation()) return;

		if (!this.targetTypes().includes(item.annotationType)) return;

		// Bibliothèque en lecture seule ? on ignore.
		if (item.library && item.library.editable === false) return;

		let text = (item.annotationText || "").trim();
		if (!text) return;

		// Ne pas écraser un commentaire existant (sauf préférence contraire).
		let existing = (item.annotationComment || "").trim();
		let overwrite = getPref("overwrite", false);
		if (existing && !overwrite) return;

		let apiKey = String(getPref("apiKey", "")).trim();
		if (!apiKey) {
			toast("Annota", "Clé API manquante (Préférences → Annota).", "error");
			return;
		}

		this.inProgress.add(id);
		let usedPlaceholder = false;
		try {
			if (getPref("showPlaceholder", true)) {
				item.annotationComment = "⏳ Génération…";
				await item.saveTx();
				usedPlaceholder = true;
			}

			let comment = await this.generateComment(text, apiKey);

			// Recharger l'item au cas où il aurait changé pendant l'appel réseau.
			let fresh = await Zotero.Items.getAsync(id);
			if (!fresh) return;
			fresh.annotationComment = comment;
			await fresh.saveTx();
			log("Commentaire généré pour l'annotation " + id);
		}
		catch (e) {
			log("Erreur génération: " + e);
			toast("Annota", "Échec de la génération : " + (e.message || e), "error");
			// Nettoyer le placeholder en cas d'échec.
			if (usedPlaceholder) {
				try {
					let fresh = await Zotero.Items.getAsync(id);
					if (fresh && (fresh.annotationComment || "").trim() === "⏳ Génération…") {
						fresh.annotationComment = "";
						await fresh.saveTx();
					}
				}
				catch (e2) { /* ignore */ }
			}
		}
		finally {
			this.inProgress.delete(id);
		}
	},

	buildSystemPrompt() {
		let tpl = String(getPref("systemPrompt", "")).trim() || this.DEFAULT_PROMPT;
		let maxWords = parseInt(getPref("maxWords", 80), 10) || 80;
		let language = String(getPref("language", "français")).trim() || "français";
		return tpl
			.replace(/\{\{\s*maxWords\s*\}\}/g, String(maxWords))
			.replace(/\{\{\s*language\s*\}\}/g, language);
	},

	async generateComment(text, apiKey) {
		let endpoint = String(getPref("endpoint", "https://api.mistral.ai/v1/chat/completions")).trim();
		let model = String(getPref("model", "mistral-large-latest")).trim() || "mistral-large-latest";
		let temp = parseFloat(getPref("temperature", 0.2));
		if (isNaN(temp)) temp = 0.2;
		temp = Math.max(0, Math.min(2, temp));

		let payload = {
			model,
			temperature: temp,
			messages: [
				{ role: "system", content: this.buildSystemPrompt() },
				{ role: "user", content: "Passage surligné :\n\"\"\"\n" + text + "\n\"\"\"" }
			]
		};

		let resp;
		try {
			resp = await Zotero.HTTP.request("POST", endpoint, {
				headers: {
					"Content-Type": "application/json",
					"Authorization": "Bearer " + apiKey
				},
				body: JSON.stringify(payload),
				responseType: "json",
				timeout: 45000
			});
		}
		catch (e) {
			let status = e && e.xmlhttp ? e.xmlhttp.status : "?";
			let detail = "";
			try { detail = e.xmlhttp ? e.xmlhttp.responseText : ""; } catch (e2) {}
			throw new Error("API (HTTP " + status + ") " + detail.slice(0, 300));
		}

		let data = resp.response;
		let content = data && data.choices && data.choices[0]
			&& data.choices[0].message && data.choices[0].message.content;
		if (!content) throw new Error("Réponse vide de l'API");

		return this.sanitize(content);
	},

	// Nettoie la sortie du modèle (retire d'éventuels blocs de code / espaces superflus).
	sanitize(raw) {
		let s = String(raw).trim();
		s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
		s = s.replace(/\n{3,}/g, "\n\n").trim();
		return s;
	}
};

// ---- Cycle de vie du plugin (Zotero 7) ----

function install() {}

async function startup({ id, version, rootURI }) {
	Annota.init({ id, version, rootURI });
	Annota.registerNotifier();

	// Exposé pour le script du panneau de préférences (prompt par défaut, reset).
	Zotero.Annota = Annota;

	Zotero.PreferencePanes.register({
		pluginID: "annota@equiriconi",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
		label: "Annota"
	});

	log("Démarré (v" + version + ")");
}

function shutdown() {
	if (Annota) {
		Annota.unregisterNotifier();
	}
	try { delete Zotero.Annota; } catch (e) {}
	Annota = undefined;
}

function uninstall() {}
