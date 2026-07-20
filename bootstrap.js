/* eslint-disable no-undef */
// Annota — extension Zotero 7/8/9
// À la création d'un surlignage, exécute un prompt configurable sur le texte
// surligné et place la sortie du modèle dans le commentaire de l'annotation.

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

	// Modèles de prompts prêts à l'emploi, proposés dans les préférences.
	// L'utilisateur peut en choisir un, le modifier, ou écrire le sien.
	// Variables substituées à l'exécution :
	//   {{text}}        texte surligné (voir buildMessages pour le mode avancé)
	//   {{title}}       titre du document source
	//   {{authors}}     auteurs du document source (noms, séparés par des virgules)
	//   {{year}}        année du document source
	//   {{abstract}}    résumé du document source (tronqué selon les préférences)
	//   {{publication}} revue / ouvrage / actes
	//   {{page}}        page du passage surligné
	//   {{maxWords}}    réglage « longueur max »
	//   {{language}}    réglage « langue de sortie »
	PRESETS: [
		{
			id: "academic",
			label: "Note académique (titre + paraphrase + références)",
			prompt: [
				"Tu transformes un passage surligné d'un article académique en une note",
				"structurée, prête à coller dans un commentaire d'annotation Zotero.",
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
			].join("\n")
		},
		{
			id: "summary",
			label: "Résumé bref",
			prompt: [
				"Résume fidèlement le passage surligné en {{language}}.",
				"{{maxWords}} mots maximum. Rends uniquement le résumé, sans introduction",
				"ni commentaire méta (pas de « Ce passage… »).",
			].join("\n")
		},
		{
			id: "plain",
			label: "Explication en langage simple",
			prompt: [
				"Explique le passage surligné en {{language}}, en langage simple et accessible,",
				"comme à une personne non spécialiste. {{maxWords}} mots maximum.",
				"Va droit à l'essentiel, sans phrase d'introduction.",
			].join("\n")
		},
		{
			id: "keypoints",
			label: "Points clés (liste à puces)",
			prompt: [
				"Extrais les points clés du passage surligné sous forme de liste à puces",
				"en {{language}}. Une puce par idée (« - » en début de ligne), formulation",
				"concise. Aucune phrase d'introduction ni de conclusion.",
			].join("\n")
		},
		{
			id: "translate",
			label: "Traduction",
			prompt: [
				"Traduis fidèlement le passage surligné en {{language}}.",
				"Rends uniquement la traduction, sans note ni commentaire.",
			].join("\n")
		}
	],

	// Prompt utilisé si aucun n'est configuré : le premier preset (académique).
	get DEFAULT_PROMPT() {
		return this.PRESETS[0].prompt;
	},

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

			let ctx = this.getContext(item);
			let comment = await this.generateComment(text, ctx, apiKey);

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

	// Tronque une chaîne à `max` caractères (0/absent = pas de limite).
	truncate(s, max) {
		s = String(s || "").trim();
		if (!max || s.length <= max) return s;
		return s.slice(0, max).trim() + "…";
	},

	// Métadonnées du document source, pour les variables {{title}}, {{authors}},
	// {{year}}, {{abstract}}, {{publication}}, {{page}}.
	getContext(item) {
		let ctx = {
			title: "", authors: "", year: "",
			abstract: "", publication: "", page: ""
		};
		try {
			// Page de l'annotation (telle qu'affichée dans le PDF).
			ctx.page = item.annotationPageLabel || "";

			let parent = item.parentItem;               // pièce jointe (PDF)
			let top = (parent && parent.parentItem) ? parent.parentItem : parent;
			if (top && typeof top.getField === "function") {
				ctx.title = top.getField("title") || "";
				ctx.publication = top.getField("publicationTitle")
					|| top.getField("bookTitle")
					|| top.getField("proceedingsTitle")
					|| "";

				let maxAbs = parseInt(getPref("maxAbstractChars", 1200), 10);
				if (isNaN(maxAbs)) maxAbs = 1200;
				ctx.abstract = this.truncate(top.getField("abstractNote") || "", maxAbs);

				let ym = String(top.getField("date") || "").match(/\d{4}/);
				if (ym) ctx.year = ym[0];

				let creators = (typeof top.getCreators === "function") ? top.getCreators() : [];
				ctx.authors = creators
					.map(c => c.lastName || c.name || "")
					.filter(Boolean)
					.join(", ");
			}
		}
		catch (e) {
			log("getContext: " + e);
		}
		return ctx;
	},

	// Bloc de contexte lisible, transmis à l'IA en mode standard.
	formatContextBlock(vars) {
		let lines = [];
		if (vars.title) lines.push("Titre : " + vars.title);
		if (vars.authors) lines.push("Auteurs : " + vars.authors);
		if (vars.year) lines.push("Année : " + vars.year);
		if (vars.publication) lines.push("Publication : " + vars.publication);
		if (vars.page) lines.push("Page du passage : " + vars.page);
		if (vars.abstract) lines.push("Résumé du document : " + vars.abstract);
		return lines.length ? "Contexte du document :\n" + lines.join("\n") : "";
	},

	// Remplace {{variable}} par sa valeur (chaîne vide si inconnue).
	substitute(tpl, vars) {
		return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
			(Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null)
				? String(vars[key]) : "");
	},

	// Construit les messages envoyés à l'API à partir du prompt configuré.
	buildMessages(text, ctx) {
		let tpl = String(getPref("systemPrompt", "")).trim() || this.DEFAULT_PROMPT;
		let vars = {
			text: text,
			title: (ctx && ctx.title) || "",
			authors: (ctx && ctx.authors) || "",
			year: (ctx && ctx.year) || "",
			abstract: (ctx && ctx.abstract) || "",
			publication: (ctx && ctx.publication) || "",
			page: (ctx && ctx.page) || "",
			maxWords: parseInt(getPref("maxWords", 80), 10) || 80,
			language: String(getPref("language", "français")).trim() || "français"
		};

		if (/\{\{\s*text\s*\}\}/.test(tpl)) {
			// Mode avancé : le prompt contient {{text}} → un seul message utilisateur.
			// L'utilisateur contrôle intégralement la structure du prompt.
			return [{ role: "user", content: this.substitute(tpl, vars) }];
		}

		// Mode standard : instructions en message système, passage (précédé du
		// contexte du document si activé) en message utilisateur.
		let parts = [];
		if (getPref("sendContext", true)) {
			let block = this.formatContextBlock(vars);
			if (block) parts.push(block);
		}
		parts.push("Passage surligné :\n\"\"\"\n" + text + "\n\"\"\"");

		return [
			{ role: "system", content: this.substitute(tpl, vars) },
			{ role: "user", content: parts.join("\n\n") }
		];
	},

	async generateComment(text, ctx, apiKey) {
		let endpoint = String(getPref("endpoint", "https://api.mistral.ai/v1/chat/completions")).trim();
		let model = String(getPref("model", "mistral-large-latest")).trim() || "mistral-large-latest";
		let temp = parseFloat(getPref("temperature", 0.2));
		if (isNaN(temp)) temp = 0.2;
		temp = Math.max(0, Math.min(2, temp));

		let payload = {
			model,
			temperature: temp,
			messages: this.buildMessages(text, ctx)
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
