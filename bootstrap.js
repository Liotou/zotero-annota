/* eslint-disable no-undef */
// Annota — extension Zotero 7/8/9
// À la création d'un surlignage, exécute un prompt configurable sur le texte
// surligné et place la sortie du modèle dans le commentaire de l'annotation.

var Annota;

const PREF_BRANCH = "annota.";

// Commentaire temporaire affiché pendant l'appel réseau (écrit puis remplacé).
const PLACEHOLDER = "⏳ Generating…";

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

	// Il n'existe volontairement AUCUN prompt par défaut : chaque couleur de
	// surlignage a le sien, et une couleur sans prompt n'est pas traitée du tout.
	// C'est ce qui permet de n'activer la génération que sur certaines couleurs.
	//
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
	// Des exemples de prompts sont fournis dans PROMPT-EXAMPLES.txt.

	// Palette de secours, si Zotero.Annotations.COLORS était indisponible.
	// Doit rester alignée sur chrome/content/zotero/xpcom/annotations.js.
	FALLBACK_COLORS: [
		{ hex: "#ffd400", name: "Yellow" },
		{ hex: "#ff6666", name: "Red" },
		{ hex: "#5fb236", name: "Green" },
		{ hex: "#2ea8e5", name: "Blue" },
		{ hex: "#a28ae5", name: "Purple" },
		{ hex: "#e56eee", name: "Magenta" },
		{ hex: "#f19837", name: "Orange" },
		{ hex: "#aaaaaa", name: "Gray" }
	],

	// Palette de surlignage lue directement depuis Zotero : elle reste ainsi
	// identique à celle du sélecteur de couleurs du lecteur, même si Zotero
	// la fait évoluer. Format source : [clé l10n, hex].
	get COLORS() {
		try {
			let raw = Zotero.Annotations && Zotero.Annotations.COLORS;
			if (Array.isArray(raw) && raw.length) {
				return raw.map(pair => ({
					hex: String(pair[1]).toLowerCase(),
					name: String(pair[0])
						.replace(/^general-/, "")
						.replace(/^./, m => m.toUpperCase())
				}));
			}
		}
		catch (e) {
			log("COLORS: lecture de la palette Zotero impossible, repli : " + e);
		}
		return this.FALLBACK_COLORS;
	},

	// Prompts par couleur : { "#ff6666": "…", … }. Vide = utiliser le prompt par défaut.
	getColorPrompts() {
		try {
			let raw = String(getPref("colorPrompts", "") || "").trim();
			if (!raw) return {};
			let obj = JSON.parse(raw);
			return (obj && typeof obj === "object") ? obj : {};
		}
		catch (e) {
			log("colorPrompts illisible (JSON invalide), ignoré : " + e);
			return {};
		}
	},

	// Réglage d'une couleur, normalisé : { prompt, trigger, template } ou null.
	// Rétrocompat : une valeur chaîne = { prompt, trigger: "auto", template: "" }.
	// trigger  "auto"   = génère à la création du surlignage
	//          "manual" = uniquement via le menu contextuel
	// template = gabarit du commentaire final ; vide = la réponse de l'IA seule.
	// Une couleur est active si elle a un prompt OU un gabarit (un gabarit sans
	// {{ai}} produit un commentaire entièrement déterministe, sans appel IA).
	getColorEntry(color) {
		if (!color) return null;
		let raw = this.getColorPrompts()[String(color).toLowerCase()];
		if (!raw) return null;
		if (typeof raw === "string") {
			return raw.trim()
				? { prompt: raw, trigger: "auto", template: "", fields: "", label: "" }
				: null;
		}
		if (typeof raw !== "object") return null;
		let prompt = String(raw.prompt || "");
		let template = String(raw.template || "");
		let fields = String(raw.fields || "");
		// Un libellé seul n'active pas une couleur : il nomme une configuration,
		// il n'en tient pas lieu. Sinon une couleur sans champ ni prompt
		// passerait pour configurée et ne produirait rien.
		if (!prompt.trim() && !template.trim() && !fields.trim()) return null;
		return {
			prompt,
			template,
			fields,
			label: String(raw.label || "").trim(),
			trigger: raw.trigger === "manual" ? "manual" : "auto"
		};
	},

	// ---- Champs personnalisés par couleur ----
	//
	// Syntaxe, une ligne par champ :  nom | Libellé | type | options
	//   type ∈ text (défaut) | textarea | check | select
	//   options : pour « select », les choix séparés par des virgules.
	// Chaque champ devient une variable {{nom}} dans le prompt ET le gabarit.
	// Les noms réservés (variables intégrées) sont ignorés pour éviter qu'un
	// champ n'écrase silencieusement {{text}}, {{comment}}, etc.
	RESERVED_VARS: [
		"text", "comment", "title", "authors", "year", "abstract",
		"publication", "page", "references", "maxWords", "language", "ai"
	],

	// Mises en forme reconnues, appliquées à la valeur du champ dans le
	// commentaire final. « plain » laisse le texte tel quel.
	FORMATS: {
		plain: v => v,
		bold: v => "<b>" + v + "</b>",
		italic: v => "<i>" + v + "</i>",
		bolditalic: v => "<b><i>" + v + "</i></b>",
		underline: v => "<u>" + v + "</u>"
	},

	_normFormat(w) {
		let k = String(w || "").toLowerCase().replace(/[\s_-]/g, "");
		// Une colonne vide n'est PAS un format : sans cela « plain » serait
		// retenu et la colonne précédente ne serait jamais examinée.
		if (!k) return null;
		if (k === "gras") k = "bold";
		if (k === "italique") k = "italic";
		if (k === "normal") k = "plain";
		if (k === "souligne" || k === "souligné") k = "underline";
		return Object.prototype.hasOwnProperty.call(this.FORMATS, k) ? k : null;
	},

	// À quoi sert chaque nom réservé : le dire vaut mieux que « nom réservé »,
	// qui n'apprend rien à qui vient de perdre un champ.
	RESERVED_HINTS: {
		text: "the highlighted passage",
		comment: "the comment already in the annotation",
		title: "the document title",
		authors: "the document authors",
		year: "the document year",
		abstract: "the document abstract",
		publication: "the journal, book or proceedings",
		page: "the page of the passage",
		references: "works cited inside the passage",
		maxWords: "your length setting",
		language: "your language setting",
		ai: "the model's reply"
	},

	// Un nom de repli toujours valide et prévisible : « page » → « myPage ».
	suggestName(name) {
		return "my" + String(name).replace(/^./, m => m.toUpperCase());
	},

	// Relit un schéma de champs et signale ce qui sera ignoré ou mal compris.
	// parseFieldSchema, lui, se tait et continue : c'est le bon comportement à
	// l'exécution, mais dans les réglages il faut le dire. Renvoie une liste de
	// { line, level, message } — « error » = ce que vous écrivez ne sera pas
	// appliqué, « warn » = appliqué autrement que prévu.
	validateFieldSchema(raw) {
		let out = [], seen = new Map();
		let lines = String(raw || "").split("\n");
		const TYPES = ["text", "textarea", "check", "select", "ai"];

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].trim();
			if (!line || line.startsWith("#")) continue;
			let n = i + 1;
			let parts = line.split("|").map(x => x.trim());
			let rawName = parts[0] || "";
			let name = rawName.replace(/[^\w]/g, "");

			if (!name) {
				out.push({ line: n, level: "error",
					message: "no field name before the first “|” — this line is ignored" });
				continue;
			}
			if (name !== rawName) {
				out.push({ line: n, level: "warn",
					message: "“" + rawName + "” becomes “" + name
						+ "” — only letters, digits and _ are kept" });
			}
			if (this.RESERVED_VARS.includes(name)) {
				out.push({ line: n, level: "error",
					message: "“" + name + "” is a built-in variable ("
						+ (this.RESERVED_HINTS[name] || "reserved")
						+ ") — this field is IGNORED. Rename it, e.g. “"
						+ this.suggestName(name) + "”." });
				continue;
			}
			if (seen.has(name)) {
				out.push({ line: n, level: "error",
					message: "“" + name + "” is already declared on line " + seen.get(name)
						+ " — both fields would write to the same value" });
			}
			else seen.set(name, n);

			let type = (parts[2] || "").toLowerCase();
			if (parts[2] && !TYPES.includes(type)) {
				out.push({ line: n, level: "warn",
					message: "unknown type “" + parts[2] + "” — “text” used instead" });
			}

			// Reproduit la lecture des colonnes 4 et 5 de parseFieldSchema.
			let col4 = parts[3] || "", col5 = parts[4] || "";
			let format = this._normFormat(col5);
			let extra = col4;
			if (!format) {
				let asFormat = this._normFormat(col4);
				if (asFormat && type !== "ai" && !(type === "select" && col4.includes(","))) {
					extra = "";
				}
			}
			if (col5 && !format) {
				out.push({ line: n, level: "warn",
					message: "unknown format “" + col5 + "” — plain text used. "
						+ "Known: bold, italic, bolditalic, underline, plain" });
			}
			if (type === "select" && !extra.split(",").map(x => x.trim()).filter(Boolean).length) {
				out.push({ line: n, level: "warn",
					message: "“select” with no options — nothing to choose from" });
			}
			if (type === "ai" && !extra.trim()) {
				out.push({ line: n, level: "error",
					message: "an “ai” field with no instruction is never filled — "
						+ "put its instruction in the 4th column" });
			}
		}
		return out;
	},

	// Variables employées dans un prompt ou une disposition qui ne correspondent
	// ni à un champ déclaré ni à une variable intégrée : presque toujours une
	// faute de frappe, et elles se substituent en silence par du vide.
	validateVariables(where, tpl, schema) {
		let known = this.RESERVED_VARS.concat(schema.map(f => f.name));
		let seen = new Set(), out = [];
		String(tpl || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => {
			if (!known.includes(name) && !seen.has(name)) {
				seen.add(name);
				out.push({ line: 0, level: "warn",
					message: where + ": “{{" + name + "}}” matches no field and no "
						+ "built-in variable — it will be replaced by nothing" });
			}
			return m;
		});
		return out;
	},

	// Contrôle complet d'une couleur, pour le panneau de réglages.
	lintColorEntry(entry) {
		entry = entry || {};
		let out = this.validateFieldSchema(entry.fields);
		let schema = this.parseFieldSchema(entry.fields);
		out = out.concat(this.validateVariables("Prompt", entry.prompt, schema));
		out = out.concat(this.validateVariables("Layout", entry.template, schema));

		// {{ai}} n'a de sens que dans la disposition.
		if (/\{\{\s*ai\s*\}\}/.test(String(entry.prompt || ""))) {
			out.push({ line: 0, level: "warn",
				message: "Prompt: “{{ai}}” is the model's own reply — it only means "
					+ "something in the layout, not in the prompt" });
		}
		return out;
	},

	// Syntaxe :  nom | Libellé | type | options | format
	// Le format peut occuper la 4e OU la 5e colonne : s'il est reconnu en 4e,
	// c'est un format, sinon ce sont les options (choix d'un « select », ou
	// consigne d'un champ « ai »). Cela garde la compatibilité ascendante.
	parseFieldSchema(raw) {
		let out = [];
		for (let line of String(raw || "").split("\n")) {
			line = line.trim();
			if (!line || line.startsWith("#")) continue;
			let parts = line.split("|").map(x => x.trim());
			let name = (parts[0] || "").replace(/[^\w]/g, "");
			if (!name) continue;
			if (this.RESERVED_VARS.includes(name)) {
				log("champ « " + name + " » ignoré : nom réservé");
				continue;
			}
			let type = (parts[2] || "text").toLowerCase();
			if (!["text", "textarea", "check", "select", "ai"].includes(type)) type = "text";

			let col4 = parts[3] || "", col5 = parts[4] || "";
			let format = this._normFormat(col5);
			let extra = col4;
			if (!format) {
				// Pas de 5e colonne : la 4e est-elle un format connu ?
				let asFormat = this._normFormat(col4);
				// Un champ « ai » garde sa consigne en 4e colonne.
				if (asFormat && type !== "ai" && !(type === "select" && col4.includes(","))) {
					format = asFormat;
					extra = "";
				}
			}

			out.push({
				name,
				label: parts[1] || name,
				type,
				format: format || "plain",
				// « select » : liste de choix. « ai » : consigne envoyée au modèle.
				options: type === "select"
					? extra.split(",").map(x => x.trim()).filter(Boolean) : [],
				prompt: type === "ai" ? extra : ""
			});
		}
		return out;
	},

	// Disposition par défaut quand une couleur a des champs mais aucun gabarit :
	// une ligne par champ, dans l'ordre déclaré, le balisage de mise en forme
	// étant intégré au gabarit lui-même. Ainsi {{nom}} reste la valeur brute et
	// il n'y a jamais de double balisage si l'on écrit sa propre disposition.
	defaultLayoutFromFields(schema) {
		return schema.map(f => {
			let fn = this.FORMATS[f.format] || this.FORMATS.plain;
			return fn("{{" + f.name + "}}");
		}).join("\n");
	},

	// Gabarit effectif d'une couleur : celui saisi, sinon celui déduit des champs.
	effectiveTemplate(entry) {
		let tpl = String((entry && entry.template) || "").trim();
		if (tpl) return tpl;
		let schema = this.parseFieldSchema(entry && entry.fields);
		return schema.length ? this.defaultLayoutFromFields(schema) : "";
	},

	// Nom que vous avez donné à cette couleur (« Objection », « Méthode »…).
	// Le nom Zotero de la teinte reste utilisé partout ailleurs : il désigne la
	// pastille à cliquer, alors que le libellé désigne ce qu'on est en train de
	// faire.
	labelForColor(color) {
		let entry = this.getColorEntry(color);
		return entry ? (entry.label || "") : "";
	},

	fieldsForColor(color) {
		let entry = this.getColorEntry(color);
		return entry ? this.parseFieldSchema(entry.fields) : [];
	},

	// Faut-il une réponse d'IA pour LE COMMENTAIRE ENTIER ?
	// Aucun gabarit ni champ → oui (la réponse EST le commentaire).
	// Gabarit contenant {{ai}} → oui. Sinon → non : les champs suffisent.
	entryNeedsAI(entry) {
		if (!entry) return false;
		let tpl = this.effectiveTemplate(entry);
		if (!tpl) return true;
		return /\{\{\s*ai\s*\}\}/.test(tpl);
	},

	// Un champ de type « ai » réclame le modèle même si le commentaire, lui,
	// est monté à partir des champs saisis.
	entryHasAIFields(entry) {
		return this.parseFieldSchema(entry && entry.fields).some(f => f.type === "ai");
	},

	// Le prompt de la couleur sert-il à RENSEIGNER LES CHAMPS ?
	// C'est le cas dès qu'une couleur a des champs et un prompt sans que la
	// disposition réclame {{ai}} : la réponse du modèle n'est alors pas un
	// commentaire libre, elle est contrainte aux champs déclarés.
	entryFillsFields(entry) {
		if (!entry || !String(entry.prompt || "").trim()) return false;
		if (this.entryNeedsAI(entry)) return false;   // la réponse EST le commentaire
		return this.parseFieldSchema(entry.fields).some(f => f.type !== "ai");
	},

	// Champs que le modèle doit renseigner : ceux restés vides. Les champs
	// « ai » ont leur propre consigne et sont traités à part.
	fieldsToFill(schema, values) {
		return schema.filter(f => f.type !== "ai"
			&& !String((values && values[f.name]) || "").trim());
	},

	// Le fournisseur est-il sollicité, à un titre ou à un autre ?
	entryUsesProvider(entry) {
		return this.entryNeedsAI(entry) || this.entryHasAIFields(entry)
			|| this.entryFillsFields(entry);
	},

	// Sera-t-il sollicité POUR CETTE annotation ? entryUsesProvider décrit la
	// couleur en général ; ici on tient compte de ce qui a déjà été saisi, car
	// un formulaire entièrement rempli ne laisse rien à demander au modèle.
	willCallProvider(entry, values) {
		if (!entry) return false;
		if (this.entryNeedsAI(entry)) return true;
		let schema = this.parseFieldSchema(entry.fields);
		if (schema.some(f => f.type === "ai" && f.prompt.trim()
				&& !String((values && values[f.name]) || "").trim())) return true;
		return this.entryFillsFields(entry)
			&& this.fieldsToFill(schema, values).length > 0;
	},

	// Prompt configuré pour cette couleur, ou "" si la couleur n'en a pas.
	getPromptForColor(color) {
		let entry = this.getColorEntry(color);
		return entry ? entry.prompt : "";
	},

	// Fournisseur actif : "openai" (Mistral ou tout endpoint compatible),
	// "ollama" (local), "cli" (Claude Code local), "apple" (Apple Intelligence).
	provider() {
		let p = String(getPref("provider", "")).trim();
		if (p === "openai" || p === "ollama" || p === "cli" || p === "apple") return p;
		// Rétrocompat avec l'ancienne case à cocher.
		return getPref("useClaudeCLI", false) ? "cli" : "openai";
	},

	// Réglages du chemin compatible OpenAI (Mistral distant ou Ollama local).
	chatConfig() {
		if (this.provider() === "ollama") {
			return {
				endpoint: String(getPref("ollamaEndpoint",
					"http://localhost:11434/v1/chat/completions")).trim(),
				model: String(getPref("ollamaModel", "llama3.1")).trim() || "llama3.1",
				apiKey: "",          // Ollama n'exige aucune clé
				requiresKey: false
			};
		}
		return {
			endpoint: String(getPref("endpoint",
				"https://api.mistral.ai/v1/chat/completions")).trim(),
			model: String(getPref("model", "mistral-large-latest")).trim()
				|| "mistral-large-latest",
			apiKey: String(getPref("apiKey", "")).trim(),
			requiresKey: true
		};
	},

	// Vérifie que le fournisseur choisi est prêt ; renvoie un message ou null.
	providerReadyError() {
		let p = this.provider();
		if (p === "apple") {
			// Disponibilité réellement vérifiée au premier appel (compilation).
			return null;
		}
		if (p === "cli") {
			return String(getPref("cliPath", "claude")).trim()
				? null : "Claude CLI path not set (Preferences → Annota).";
		}
		let cfg = this.chatConfig();
		if (!cfg.endpoint) {
			return (p === "ollama" ? "Ollama endpoint" : "API endpoint")
				+ " not set (Preferences → Annota).";
		}
		if (cfg.requiresKey && !cfg.apiKey) {
			return "API key missing (Preferences → Annota).";
		}
		return null;
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
		log("Notifier registered (id=" + this.notifierID + ")");
	},

	unregisterNotifier() {
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
	},

	notifierCallback: {
		notify(event, type, ids, _extraData) {
			// On ne réagit qu'à la CRÉATION d'items. Il n'y a pas d'interrupteur
			// global : handleItem() ne génère que pour les couleurs réglées sur
			// « auto ». Tout mettre sur « à la demande » désactive l'automatique.
			if (event !== "add" || type !== "item") return;
			let t0 = Date.now();
			for (let id of ids) {
				// fire-and-forget : ne pas bloquer la transaction Zotero
				Annota.handleItem(id, t0).catch(e => log("handleItem: " + e));
			}
		}
	},

	targetTypes() {
		let types = ["highlight"];
		if (getPref("alsoUnderline", false)) types.push("underline");
		return types;
	},

	async handleItem(id, notifiedAt) {
		if (this.inProgress.has(id)) return;
		let tEnter = Date.now();

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

		// Mode 1 (automatique) : ne se déclenche que si la couleur a un prompt
		// ET que ce prompt est réglé sur « auto ». Les couleurs « manuel » ne
		// réagissent qu'au menu contextuel. Couleur sans prompt = ignorée.
		let entry = this.getColorEntry(item.annotationColor);
		if (!entry) {
			log("annotation " + id + " ignorée : couleur " + item.annotationColor
				+ " sans prompt, gabarit ni champs");
			return;
		}
		// Sert de couleur par défaut au prochain formulaire de sélection : on
		// surligne rarement une seule fois dans la même couleur.
		this._lastColor = item.annotationColor;

		// Un formulaire rempli dans le popup de sélection VAUT demande explicite :
		// on exécute même sur une couleur réglée sur « à la demande », sinon la
		// saisie serait silencieusement perdue à la validation.
		let pending = this.peekPendingFields(text);
		let filled = this._hasFilledValues(pending);
		if (entry.trigger !== "auto" && !filled) {
			log("annotation " + id + " ignorée : couleur en mode « à la demande »"
				+ " et aucun champ saisi");
			return;
		}

		// Commentaire déjà saisi (paraphrase manuelle) : capturé avant tout,
		// pour la variable {{comment}} et pour respecter « ne pas écraser ».
		let existing = (item.annotationComment || "").trim();
		let overwrite = getPref("overwrite", false);
		if (existing && !overwrite) return;

		// Un commentaire monté à la main n'appelle aucun modèle : inutile
		// d'exiger une clé API ou le CLI dans ce cas. On raisonne sur CETTE
		// annotation (willCallProvider), pas sur la couleur en général, car un
		// formulaire entièrement rempli ne laisse rien à demander.
		let callsProvider = this.willCallProvider(entry, pending);
		if (callsProvider) {
			let notReady = this.providerReadyError();
			if (notReady) {
				toast("Annota", notReady, "error");
				return;
			}
		}

		this.inProgress.add(id);
		let usedPlaceholder = false;
		try {
			if (getPref("showPlaceholder", true) && callsProvider) {
				item.annotationComment = PLACEHOLDER;
				await item.saveTx();
				usedPlaceholder = true;
			}

			let tBuild = Date.now();
			let ctx = this.getContext(item);
			// Valeurs saisies dans le popup de sélection juste avant validation.
			let fields = this.takePendingFields(text);
			// Résolution des références différée : buildComment ne l'appelle que
			// si le commentaire ou le modèle s'en sert. Elle ouvre le PDF et en
			// parcourt les liens, ce qui se paie en secondes.
			let comment = await this.buildComment({
				text, ctx, color: item.annotationColor, comment: existing, fields,
				getRefs: () => this.getReferences(item, text)
			});
			if (comment === null) return;
			// Un commentaire vide signifie que rien n'a pu être produit (champs
			// perdus, gabarit sans contenu) : ne pas écraser pour autant.
			if (!String(comment).trim()) {
				log("rien à écrire pour l'annotation " + id + " (résultat vide)");
				// Un vide APRÈS un appel au modèle est un échec, pas un choix :
				// on le signale. Un vide sans appel (couleur non configurée,
				// formulaire laissé vierge) n'a rien d'anormal.
				if (callsProvider) await this.markFailed(id, "résultat vide");
				return;
			}

			// Recharger l'item au cas où il aurait changé pendant l'appel réseau.
			let fresh = await Zotero.Items.getAsync(id);
			if (!fresh) return;
			fresh.annotationComment = comment;
			this.setFailedTag(fresh, false);   // succès : l'échec précédent s'efface
			let tSave = Date.now();
			await fresh.saveTx();
			tSave = Date.now() - tSave;

			// Relevé complet : c'est la seule façon de distinguer ce qu'Annota
			// consomme de ce qu'elle attend. « notif » = délai entre l'événement
			// de création et notre prise en main (Zotero et les autres modules),
			// « écriture » = durée de la transaction, qui peut être mise en file
			// derrière d'autres travaux en cours.
			let t = this._timings || { refs: 0, ai: 0, build: 0 };
			log("annotation " + id + " — relevé : notif="
				+ (notifiedAt ? tEnter - notifiedAt : 0) + " ms, prépa="
				+ (tBuild - tEnter) + " ms, refs=" + t.refs + " ms, ia=" + t.ai
				+ " ms, écriture=" + tSave + " ms, total Annota="
				+ (Date.now() - tEnter) + " ms");
		}
		catch (e) {
			log("Generation error: " + e);
			toast("Annota", "Generation failed: " + (e.message || e), "error");
			await this.markFailed(id, String(e.message || e));
			// Nettoyer le placeholder en cas d'échec.
			if (usedPlaceholder) {
				try {
					let fresh = await Zotero.Items.getAsync(id);
					if (fresh && (fresh.annotationComment || "").trim() === PLACEHOLDER) {
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

	// ---- Échecs visibles ----
	//
	// Un appel raté laissait un surlignage sans commentaire : rien ne le
	// distinguait d'un surlignage volontairement nu, et on ne s'en apercevait
	// qu'en relisant. On pose donc une étiquette sur l'annotation — visible
	// dans le lecteur, cherchable dans la bibliothèque, et point d'entrée du
	// « Retry failed comments » du menu contextuel.
	failedTag() {
		if (!getPref("markFailures", true)) return "";
		return String(getPref("failedTag", "annota-failed") || "").trim();
	},

	hasFailedTag(item) {
		let tag = this.failedTag();
		try { return !!tag && typeof item.hasTag === "function" && item.hasTag(tag); }
		catch (e) { return false; }
	},

	// Pose l'étiquette SANS enregistrer : l'appelant groupe avec sa propre
	// écriture quand il en a une, pour ne pas provoquer deux rafraîchissements.
	setFailedTag(item, on) {
		let tag = this.failedTag();
		if (!tag) return false;
		try {
			let has = this.hasFailedTag(item);
			if (on && !has) { item.addTag(tag, 0); return true; }
			if (!on && has) { item.removeTag(tag); return true; }
		}
		catch (e) {
			log("setFailedTag: " + e);
		}
		return false;
	},

	async markFailed(id, why) {
		if (!this.failedTag()) return;
		try {
			let fresh = await Zotero.Items.getAsync(id);
			if (fresh && this.setFailedTag(fresh, true)) {
				await fresh.saveTx();
				log("annotation " + id + " marquée en échec : " + why);
			}
		}
		catch (e) {
			log("markFailed: " + e);
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

	// ---- Résolution des références citées dans le passage ----
	//
	// Quand le passage contient « [1] » ou « (Moulin, 1999) », on va chercher
	// l'entrée bibliographique correspondante DANS LE PDF (section References)
	// et on la transmet à l'IA. Le texte du PDF est extrait via
	// Zotero.PDFWorker.getFullText puis mis en cache par pièce jointe.
	//
	// Limite assumée : suppose que la bibliographie est présente comme texte
	// dans le PDF. Sinon on renvoie "" et rien ne change.

	_fullTextCache: new Map(),

	// Détecte les appels de citation dans le passage surligné.
	detectCitationMarkers(text) {
		let numbers = new Set();
		let authorYears = [];
		let seen = new Set();
		let m;

		// Numériques : [1] [1,2] [1-3] [1, 2, 5–7]
		let numRe = /\[([\d\s,;‐-―-]+)\]/g;
		while ((m = numRe.exec(text)) !== null) {
			if (!/\d/.test(m[1])) continue;
			for (let part of m[1].split(/[,;]/)) {
				part = part.trim();
				let range = part.match(/^(\d{1,3})\s*[‐-―-]\s*(\d{1,3})$/);
				if (range) {
					let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
					if (b >= a && b - a < 30) for (let i = a; i <= b; i++) numbers.add(i);
				}
				else if (/^\d{1,3}$/.test(part)) numbers.add(parseInt(part, 10));
			}
		}

		let pushAY = (author, year) => {
			author = String(author).trim().replace(/\s+/g, " ");
			let key = author.toLowerCase() + "|" + year;
			if (author && !seen.has(key)) { seen.add(key); authorYears.push({ author, year }); }
		};

		// Auteur-année entre parenthèses : (Moulin, 1999 ; Jacques et al., 2009)
		let parenRe = /\(([^()]{3,200})\)/g;
		while ((m = parenRe.exec(text)) !== null) {
			for (let chunk of m[1].split(/;/)) {
				let ay = chunk.match(
					/([\p{Lu}][\p{L}'’-]+(?:\s+(?:et\s+al\.?|and|&|y|und)\s*[\p{L}'’-]*)?)[,\s]+((?:1[6-9]|20)\d{2})[a-z]?/u);
				if (ay) pushAY(ay[1], ay[2]);
			}
		}

		// Auteur-année narratif : Moulin (1999), Jacques et al. (2009)
		let narrRe = /([\p{Lu}][\p{L}'’-]+(?:\s+(?:et\s+al\.?|and|&)\s*[\p{L}'’-]*)?)\s*\(((?:1[6-9]|20)\d{2})[a-z]?\)/gu;
		while ((m = narrRe.exec(text)) !== null) pushAY(m[1], m[2]);

		return { numbers: Array.from(numbers).sort((a, b) => a - b), authorYears };
	},

	// Texte intégral du PDF parent, mis en cache par pièce jointe.
	async getAttachmentFullText(item) {
		try {
			let att = item.parentItem;   // l'annotation appartient à la pièce jointe
			if (!att || !att.isPDFAttachment || !att.isPDFAttachment()) return "";
			if (this._fullTextCache.has(att.id)) return this._fullTextCache.get(att.id);

			let res = await Zotero.PDFWorker.getFullText(att.id, null);
			let text = (res && res.text) ? String(res.text) : "";
			// Cache borné : quelques documents en mémoire au plus.
			if (this._fullTextCache.size > 5) {
				this._fullTextCache.delete(this._fullTextCache.keys().next().value);
			}
			this._fullTextCache.set(att.id, text);
			return text;
		}
		catch (e) {
			log("getAttachmentFullText: " + e);
			return "";
		}
	},

	// Isole la section bibliographique (dernière occurrence d'un titre connu).
	findBibliographySection(fullText) {
		if (!fullText) return "";
		let re = /\b(references?|bibliograph(?:y|ie)|works\s+cited|literature\s+cited|r[eé]f[eé]rences?(?:\s+bibliographiques)?|referencias|refer[eê]ncias|literaturverzeichnis)\b\s*:?/gi;
		let last = -1, m;
		let floor = Math.floor(fullText.length * 0.4);   // seconde partie du document
		while ((m = re.exec(fullText)) !== null) {
			if (m.index >= floor) last = m.index + m[0].length;
		}
		return last < 0 ? "" : fullText.slice(last);
	},

	// Coupe au début de l'entrée bibliographique SUIVANTE.
	//
	// Dans le texte extrait d'un PDF, les entrées se suivent souvent sans retour
	// à la ligne : « …(last accessed 2023). Haddaway, N.R., P. Woodcock… ».
	// Se fier au saut de ligne laissait donc déborder l'entrée voisine.
	// On repère « ponctuation + espace » suivi d'un début d'entrée :
	//   - « Nom, X. »  (nom de famille puis initiale) ;
	//   - « [12] »     (bibliographie numérotée).
	// Le seuil minKeep protège le début de l'entrée courante.
	_cutAtNextEntry(s, minKeep = 40) {
		s = String(s);
		let re = /[.!?)\]]\s+(\[\d{1,3}\]|\p{Lu}[\p{L}'’-]+,\s+\p{Lu}\.)/gu;
		let m;
		while ((m = re.exec(s)) !== null) {
			let idx = m.index + m[0].indexOf(m[1]);
			if (idx >= minKeep) return s.slice(0, idx).trim();
		}
		return s;
	},

	// Coupe une entrée trop longue proprement.
	_trimEntry(s, max = 320) {
		s = String(s).replace(/\s+/g, " ").trim();
		if (s.length <= max) return s;
		let cut = s.slice(0, max);
		let dot = cut.lastIndexOf(". ");
		return dot > max * 0.5 ? cut.slice(0, dot + 1) : cut.trim() + "…";
	},

	// Variantes « structurées » : renvoient { marker, entry } au lieu d'une
	// chaîne. Les fonctions historiques ci-dessous s'appuient dessus, afin que
	// l'index bibliographique et le prompt partagent exactement la même
	// résolution.
	resolveNumericRefs(bib, numbers) {
		return this.resolveNumericRefsStructured(bib, numbers)
			.map(r => r.marker + " " + r.entry);
	},

	resolveAuthorYearRefs(bib, pairs) {
		return this.resolveAuthorYearRefsStructured(bib, pairs)
			.map(r => r.marker + " → " + r.entry);
	},

	// Entrées numérotées : « [12] Auteur… » ou « 12. Auteur… »
	resolveNumericRefsStructured(bib, numbers) {
		if (!bib || !numbers.length) return [];
		let markers = [], m;
		let re = /(?:^|[\s\n])(?:\[(\d{1,3})\]|(\d{1,3})\.(?=\s))/g;
		while ((m = re.exec(bib)) !== null) {
			markers.push({ n: parseInt(m[1] || m[2], 10), start: m.index + m[0].length, mStart: m.index });
		}
		if (!markers.length) return [];

		let out = [], wanted = new Set(numbers);
		for (let i = 0; i < markers.length; i++) {
			if (!wanted.has(markers[i].n)) continue;
			let end = (i + 1 < markers.length)
				? markers[i + 1].mStart
				: Math.min(bib.length, markers[i].start + 600);
			let body = this._trimEntry(
				this._cutAtNextEntry(bib.slice(markers[i].start, end)));
			if (body.length > 15) {
				out.push({ marker: "[" + markers[i].n + "]", entry: body });
				wanted.delete(markers[i].n);
			}
		}
		return out;
	},

	// Entrées auteur-année : fenêtre autour du nom suivi de l'année.
	resolveAuthorYearRefsStructured(bib, pairs) {
		if (!bib || !pairs.length) return [];
		let out = [];
		for (let { author, year } of pairs) {
			// Nom de famille = premier mot (« Moulin et al. » → « Moulin »).
			let surname = author.split(/\s+/)[0].replace(/[^\p{L}'’-]/gu, "");
			if (surname.length < 2) continue;
			let esc = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			let re = new RegExp("\\b" + esc + "\\b", "giu");
			let m, found = null;
			while ((m = re.exec(bib)) !== null) {
				let win = bib.slice(m.index, m.index + 700);
				if (win.includes(year)) { found = win; break; }
			}
			if (found) {
				// Fin d'entrée = début de l'entrée suivante, avec ou sans retour à
				// la ligne. Ne PAS couper au premier point : il tombe juste après
				// « (1999). » et amputerait le titre et la revue.
				let body = this._trimEntry(this._cutAtNextEntry(found));
				if (body.length > 15) {
					out.push({ marker: "(" + author + ", " + year + ")", entry: body });
				}
			}
		}
		return out;
	},

	// ---- Voie déterministe : les liens internes du PDF ----
	//
	// C'est le mécanisme qui produit le popup au survol dans le lecteur Zotero :
	// l'appel de citation est une annotation /Link du PDF dont la destination
	// pointe sur l'entrée bibliographique. On suit ce lien plutôt que de deviner.
	// Nécessite que le PDF soit ouvert dans un onglet (pdf.js y est chargé) ;
	// sinon on retombe sur l'analyse du texte.

	// Lecteur ouvert pour cette pièce jointe, ou null.
	findReaderFor(attachmentID) {
		try {
			let readers = Zotero.Reader && Zotero.Reader._readers;
			if (!readers) return null;
			return readers.find(r => r && r.itemID === attachmentID) || null;
		}
		catch (e) {
			return null;
		}
	},

	// Document pdf.js du lecteur (traverse l'iframe du visualiseur).
	getPDFDocument(reader) {
		try {
			let win = reader && reader._internalReader
				&& reader._internalReader._primaryView
				&& reader._internalReader._primaryView._iframeWindow;
			if (!win) return null;
			let app = win.PDFViewerApplication
				|| (win.wrappedJSObject && win.wrappedJSObject.PDFViewerApplication);
			return (app && app.pdfDocument) || null;
		}
		catch (e) {
			log("getPDFDocument: " + e);
			return null;
		}
	},

	// Deux rectangles PDF se recouvrent-ils ? (marge pour les exposants)
	_rectsOverlap(a, b, pad = 2) {
		let ax1 = Math.min(a[0], a[2]) - pad, ax2 = Math.max(a[0], a[2]) + pad;
		let ay1 = Math.min(a[1], a[3]) - pad, ay2 = Math.max(a[1], a[3]) + pad;
		let bx1 = Math.min(b[0], b[2]), bx2 = Math.max(b[0], b[2]);
		let by1 = Math.min(b[1], b[3]), by2 = Math.max(b[1], b[3]);
		return ax1 <= bx2 && bx1 <= ax2 && ay1 <= by2 && by1 <= ay2;
	},

	// Résout la destination d'un lien en { pageIndex, y }.
	async _resolveDestination(pdfDoc, dest) {
		try {
			let d = dest;
			if (typeof d === "string") d = await pdfDoc.getDestination(d);
			if (!Array.isArray(d) || !d.length) return null;
			let pageIndex = await pdfDoc.getPageIndex(d[0]);
			// [ref, {name:'XYZ'}, x, y, zoom] — y absent pour /Fit.
			let y = (typeof d[3] === "number") ? d[3] : null;
			return { pageIndex, y };
		}
		catch (e) {
			log("_resolveDestination: " + e);
			return null;
		}
	},

	// Texte de la page à partir de la position de destination (vers le bas).
	async _textAtDestination(pdfDoc, pageIndex, y, maxChars = 600) {
		try {
			let page = await pdfDoc.getPage(pageIndex + 1);
			let content = await page.getTextContent();
			let items = (content && content.items) || [];
			let rows = [];
			for (let it of items) {
				let str = it.str;
				if (!str) continue;
				let ty = (it.transform && it.transform.length > 5) ? it.transform[5] : null;
				if (ty === null) continue;
				// En coordonnées PDF l'origine est en bas : l'entrée commence à y
				// et se poursuit vers le bas (y décroissant). Marge vers le haut
				// pour rattraper une destination pointant la ligne au-dessus.
				if (y !== null && ty > y + 12) continue;
				rows.push({ y: ty, str, eol: it.hasEOL });
			}
			rows.sort((a, b) => b.y - a.y);
			// Début d'une entrée bibliographique : « [12] », « 12. » ou « Nom, P. ».
			let entryStart = /^(\[\d{1,3}\]|\d{1,3}\.\s|\p{Lu}[\p{L}'’-]+,\s+\p{Lu}\.)/u;
			let out = "";
			for (let r of rows) {
				// S'arrêter au début de l'entrée SUIVANTE, sinon on colle deux
				// références bout à bout et l'IA attribue la mauvaise source.
				if (out.length > 30 && entryStart.test(r.str.trim())) break;
				out += r.str + (r.eol ? "\n" : " ");
				if (out.length >= maxChars) break;
			}
			return out.trim();
		}
		catch (e) {
			log("_textAtDestination: " + e);
			return "";
		}
	},

	// Suit les liens internes chevauchant le surlignage. Renvoie [] si le PDF
	// n'est pas ouvert ou ne contient pas de liens exploitables.
	async getLinkedReferences(item) {
		try {
			let att = item.parentItem;
			if (!att) return [];
			let reader = this.findReaderFor(att.id);
			if (!reader) return [];
			let pdfDoc = this.getPDFDocument(reader);
			if (!pdfDoc) return [];

			let pos = item.annotationPosition;
			if (typeof pos === "string") pos = JSON.parse(pos);
			if (!pos || typeof pos.pageIndex !== "number" || !Array.isArray(pos.rects)) return [];

			let page = await pdfDoc.getPage(pos.pageIndex + 1);
			let annots = await page.getAnnotations();
			if (!annots || !annots.length) return [];

			let max = parseInt(getPref("maxRefs", 8), 10) || 8;
			let out = [], seen = new Set();
			for (let a of annots) {
				if (out.length >= max) break;
				// Uniquement les liens internes (une destination, pas une URL).
				let isLink = a && (a.subtype === "Link" || a.subtype === "link");
				let dest = a && (a.dest || (a.action && a.action.dest));
				if (!isLink || !dest || a.url) continue;
				if (!Array.isArray(a.rect)) continue;
				if (!pos.rects.some(r => this._rectsOverlap(a.rect, r))) continue;

				let target = await this._resolveDestination(pdfDoc, dest);
				if (!target) continue;
				let key = target.pageIndex + ":" + (target.y === null ? "?" : Math.round(target.y));
				if (seen.has(key)) continue;
				seen.add(key);

				let txt = await this._textAtDestination(pdfDoc, target.pageIndex, target.y);
				txt = this._trimEntry(this._cutAtNextEntry(txt));
				if (txt.length > 15) out.push(txt);
			}
			if (out.length) log("Références résolues par lien PDF : " + out.length);
			return out;
		}
		catch (e) {
			log("getLinkedReferences: " + e);
			return [];
		}
	},

	// Socle commun : liens internes du PDF d'abord (déterministe, même principe
	// que le popup de Zotero), analyse du texte en repli.
	// Renvoie [{ marker, entry }] — le prompt et l'index partagent ce résultat.
	async collectReferencesStructured(item, text) {
		if (!getPref("resolveCitations", true)) return [];
		try {
			let max = parseInt(getPref("maxRefs", 8), 10) || 8;
			let markers = this.detectCitationMarkers(text);

			// Aucun appel de citation dans le passage : il n'y a rien à résoudre.
			// Ce contrôle purement textuel est immédiat, alors que la suite ouvre
			// le PDF et parcourt ses liens — plusieurs secondes sur un gros
			// document. La grande majorité des passages ne cite personne.
			if (!markers.numbers.length && !markers.authorYears.length) {
				log("aucun appel de citation dans le passage : références ignorées");
				return [];
			}

			// 1. Voie sûre : suivre les liens du PDF.
			let linked = await this.getLinkedReferences(item);
			if (linked.length) {
				// Si le nombre d'appels numériques correspond exactement, les
				// apparier dans l'ordre pour conserver « [1] », « [2] ».
				let nums = markers.numbers;
				let pair = (nums.length === linked.length);
				return linked.slice(0, max).map((entry, i) => ({
					marker: pair ? "[" + nums[i] + "]" : "",
					entry
				}));
			}

			// 2. Repli : chercher les appels détectés dans la bibliographie.
			let fullText = await this.getAttachmentFullText(item);
			if (!fullText) return [];
			let bib = this.findBibliographySection(fullText);
			if (!bib) return [];

			return this.resolveNumericRefsStructured(bib, markers.numbers)
				.concat(this.resolveAuthorYearRefsStructured(bib, markers.authorYears))
				.slice(0, max);
		}
		catch (e) {
			log("collectReferencesStructured: " + e);
			return [];
		}
	},

	// Version texte, transmise à l'IA via {{references}}.
	async getReferences(item, text) {
		let refs = await this.collectReferencesStructured(item, text);
		return refs.map(r => r.marker ? r.marker + " " + r.entry : r.entry).join("\n");
	},

	// Bloc de contexte lisible, transmis à l'IA en mode standard.
	formatContextBlock(vars) {
		let lines = [];
		if (vars.title) lines.push("Title: " + vars.title);
		if (vars.authors) lines.push("Authors: " + vars.authors);
		if (vars.year) lines.push("Year: " + vars.year);
		if (vars.publication) lines.push("Publication: " + vars.publication);
		if (vars.page) lines.push("Passage page: " + vars.page);
		if (vars.abstract) lines.push("Document abstract: " + vars.abstract);
		let block = lines.length ? "Document context:\n" + lines.join("\n") : "";
		if (vars.references) {
			block += (block ? "\n\n" : "")
				+ "Works cited in the passage (resolved from this article's reference list):\n"
				+ vars.references;
		}
		return block;
	},

	// Remplace {{variable}} par sa valeur (chaîne vide si inconnue).
	substitute(tpl, vars) {
		return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
			(Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null)
				? String(vars[key]) : "");
	},

	// Construit le prompt à envoyer : { system, user }.
	// - Mode avancé (le prompt contient {{text}} ou {{comment}}) : tout est mis
	//   dans le message utilisateur, l'utilisateur contrôle la structure.
	// - Mode standard : le prompt sert d'instructions (system), le passage (et
	//   le contexte du document si activé) est ajouté comme message utilisateur.
	// Variables disponibles dans le prompt ET dans le gabarit de sortie.
	buildVars({ text, ctx, comment, fields }) {
		let vars = {
			text: text || "",
			comment: comment || "",
			title: (ctx && ctx.title) || "",
			authors: (ctx && ctx.authors) || "",
			year: (ctx && ctx.year) || "",
			abstract: (ctx && ctx.abstract) || "",
			publication: (ctx && ctx.publication) || "",
			page: (ctx && ctx.page) || "",
			references: (ctx && ctx.references) || "",
			maxWords: parseInt(getPref("maxWords", 80), 10) || 80,
			language: String(getPref("language", "français")).trim() || "français"
		};
		// Champs saisis à la main : n'écrasent jamais une variable intégrée.
		if (fields) {
			for (let k of Object.keys(fields)) {
				if (!this.RESERVED_VARS.includes(k)) vars[k] = fields[k];
			}
		}
		return vars;
	},

	buildPrompt({ text, ctx, color, comment, fields, promptOverride }) {
		let tpl = promptOverride || this.getPromptForColor(color);
		let vars = this.buildVars({ text, ctx, comment, fields });

		let selfContained = /\{\{\s*(text|comment)\s*\}\}/.test(tpl);
		if (selfContained) {
			return { system: "", user: this.substitute(tpl, vars) };
		}

		let parts = [];
		if (getPref("sendContext", true)) {
			let block = this.formatContextBlock(vars);
			if (block) parts.push(block);
		}
		if (comment && String(comment).trim()) {
			parts.push("Existing note:\n\"\"\"\n" + comment + "\n\"\"\"");
		}
		parts.push("Highlighted passage:\n\"\"\"\n" + text + "\n\"\"\"");

		return { system: this.substitute(tpl, vars), user: parts.join("\n\n") };
	},

	// Consigne ajoutée au prompt de la couleur pour que la réponse épouse
	// EXACTEMENT les champs déclarés : le modèle ne rédige pas un commentaire
	// libre, il renseigne les champs restés vides, un par ligne. C'est ce qui
	// rend le prompt dépendant des champs définis plus haut.
	buildFieldInstruction(toFill, schema, values) {
		let lines = [
			"",
			"Fill in the fields listed below, and nothing else. Answer with one"
				+ " line per field, in the form `name: value`, using exactly these"
				+ " names. No preamble, no bullet points, no extra field.",
			""
		];
		for (let f of toFill) {
			let d = "- " + f.name + " (" + f.label + ")";
			if (f.type === "select" && f.options.length) {
				d += " — choose exactly one of: " + f.options.join(", ");
			}
			else if (f.type === "check") d += " — answer true or false";
			else if (f.type === "textarea") d += " — may span several lines";
			lines.push(d);
		}
		// Ce que l'utilisateur a déjà écrit sert de contexte, jamais de cible :
		// sa saisie ne doit pas être réécrite.
		let given = schema.filter(f => !toFill.includes(f)
			&& String((values && values[f.name]) || "").trim());
		if (given.length) {
			lines.push("", "The user already filled in these fields. Do not repeat"
				+ " them and do not rewrite them — use them as context:");
			for (let f of given) {
				lines.push("- " + f.name + " (" + f.label + "): " + values[f.name]);
			}
		}
		return lines.join("\n");
	},

	// Variante JSON de la consigne : mêmes règles, format imposé par le
	// fournisseur plutôt que demandé en toutes lettres.
	buildFieldInstructionJSON(toFill, schema, values) {
		let lines = [
			"",
			"Answer with a single JSON object, and nothing else. One key per field"
				+ " listed below, using exactly these names, with string values"
				+ " (use \"\" for a field you cannot fill).",
			""
		];
		for (let f of toFill) {
			let d = "- " + f.name + " (" + f.label + ")";
			if (f.type === "select" && f.options.length) {
				d += " — one of: " + f.options.join(", ");
			}
			else if (f.type === "check") d += " — \"true\" or \"\"";
			lines.push(d);
		}
		let given = schema.filter(f => !toFill.includes(f)
			&& String((values && values[f.name]) || "").trim());
		if (given.length) {
			lines.push("", "Already filled in by the user. Do not include these keys,"
				+ " do not rewrite them — use them as context:");
			for (let f of given) {
				lines.push("- " + f.name + " (" + f.label + "): " + values[f.name]);
			}
		}
		return lines.join("\n");
	},

	// Relit une réponse JSON. Renvoie null si ce n'en est pas — l'appelant
	// retombe alors sur parseFieldReply, qui n'exige aucun format.
	parseJSONReply(reply, toFill) {
		let raw = String(reply || "").trim();
		// Les modèles enrobent volontiers leur JSON dans un bloc de code.
		let fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence) raw = fence[1].trim();
		// … ou l'accompagnent d'une phrase : on isole le premier objet complet.
		let first = raw.indexOf("{"), last = raw.lastIndexOf("}");
		if (first === -1 || last <= first) return null;
		raw = raw.slice(first, last + 1);

		let obj;
		try { obj = JSON.parse(raw); }
		catch (e) { return null; }
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

		let byName = {};
		for (let f of toFill) byName[f.name] = f;
		let out = {}, seen = 0;
		for (let k of Object.keys(obj)) {
			if (!byName[k]) continue;              // clé inventée : ignorée
			let v = obj[k];
			if (v === null || v === undefined) v = "";
			if (typeof v === "boolean") v = v ? "true" : "";
			else if (Array.isArray(v)) v = v.filter(x => x != null).join(", ");
			else if (typeof v === "object") continue;
			// Le JSON n'est pas passé par sanitize : le Markdown y survit.
			v = this.unwrapWholeTag(this.demarkdown(String(v)).trim());
			if (byName[k].type === "check") v = /^(true|yes|oui|1|x)$/i.test(v) ? "true" : "";
			out[k] = v;
			seen++;
		}
		return seen ? out : null;
	},

	// Relit une réponse « nom: valeur ». Tolère les puces, le gras Markdown et
	// les valeurs sur plusieurs lignes (une ligne sans marqueur prolonge le
	// champ courant). Seuls les champs demandés sont retenus.
	parseFieldReply(reply, toFill) {
		let names = toFill.map(f => f.name);
		let byName = {};
		for (let f of toFill) byName[f.name] = f;

		let out = {}, current = null;
		for (let raw of String(reply || "").split("\n")) {
			let m = raw.match(/^\s*(?:[-*]\s*)?\**\s*(\w+)\s*\**\s*:\s*(.*)$/);
			if (m && names.includes(m[1])) {
				current = m[1];
				out[current] = m[2].trim();
				continue;
			}
			if (current !== null && raw.trim()) {
				out[current] += (out[current] ? "\n" : "") + raw.trim();
			}
		}

		// Un seul champ demandé et aucun marqueur reconnu : toute la réponse
		// lui revient, plutôt que de perdre une réponse parfaitement utilisable.
		if (!Object.keys(out).length && names.length === 1) {
			out[names[0]] = String(reply || "").trim();
		}

		for (let k of Object.keys(out)) {
			let v = this.unwrapWholeTag(out[k].trim())
				.replace(/^["«»\s]+|["«»\s]+$/g, "");
			if (byName[k].type === "check") {
				v = /^(true|yes|oui|1|x)$/i.test(v) ? "true" : "";
			}
			out[k] = v;
		}
		return out;
	},

	// Une clé absente ou refusée ne se répare pas en réessayant : inutile de
	// faire attendre trois fois pour la même réponse.
	_worthRetrying(e) {
		// Clé absente ou refusée, modèle inexistant, requête invalide : la
		// réponse sera identique au second essai.
		let st = (e && typeof e.status === "number") ? e.status : 0;
		if ([400, 401, 403, 404].includes(st)) return false;
		// Fournisseurs sans statut (CLI, Apple) : il ne reste que le libellé.
		let m = String((e && e.message) || e || "");
		return !/api key|unauthorized|forbidden|not found|introuvable/i.test(m);
	},

	// Les fournisseurs HTTP acceptent response_format ; le CLI et Apple n'ont
	// pas d'équivalent, on y reste sur la lecture « nom: valeur ».
	supportsJSON() {
		let p = this.provider();
		return (p === "openai" || p === "ollama") && getPref("structuredOutput", true);
	},

	async generateComment({ text, ctx, color, comment, fields, promptOverride, json }) {
		let prompt = this.buildPrompt({ text, ctx, color, comment, fields, promptOverride });
		let p = this.provider();
		let call = () => {
			if (p === "cli") return this.callCLI(prompt);
			if (p === "apple") return this.callApple(prompt);
			return this.callOpenAI(prompt, { json: !!json });
		};

		// Une coupure réseau ou un modèle qui bafouille ne doivent pas coûter
		// l'annotation : on retente avant de renoncer.
		let tries = parseInt(getPref("retries", 1), 10);
		if (isNaN(tries) || tries < 0) tries = 1;
		let last;
		for (let i = 0; i <= tries; i++) {
			try { return await call(); }
			catch (e) {
				last = e;
				if (i === tries || !this._worthRetrying(e)) break;
				log("échec de génération, nouvel essai (" + (i + 1) + "/" + tries + ") : " + e);
			}
		}
		throw last;
	},

	// Rend le gabarit de sortie. Une ligne dont TOUTES les variables sont vides
	// est supprimée : sans cela, une référence non résolue laisserait une ligne
	// orpheline du type « <i></i> » dans le commentaire.
	renderTemplate(tpl, vars) {
		let out = [];
		for (let line of String(tpl).split("\n")) {
			let names = [];
			line.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => { names.push(n); return m; });
			if (names.length) {
				let allEmpty = names.every(
					n => !(vars[n] != null && String(vars[n]).trim()));
				if (allEmpty) continue;
			}
			out.push(this.substitute(line, vars));
		}
		return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	},

	// Produit le commentaire final d'une annotation : réponse de l'IA seule, ou
	// gabarit mêlant cette réponse ({{ai}}) et des entrées déterministes.
	// Renvoie null si la couleur n'a rien à produire.
	async buildComment({ text, ctx, color, comment, fields, getRefs }) {
		let entry = this.getColorEntry(color);
		if (!entry) return null;

		ctx = ctx || {};
		let schema = this.parseFieldSchema(entry.fields);
		let values = Object.assign({}, fields || {});

		// 0. Références citées : leur résolution ouvre le PDF et parcourt ses
		//    liens internes, soit plusieurs secondes sur un gros document. On ne
		//    la déclenche donc que si quelque chose s'en sert réellement — un
		//    commentaire monté à la main n'a rien à attendre.
		let t0 = Date.now(), tRefs = 0, tAI = 0;
		if (getRefs && !ctx.references) {
			let tplWantsRefs = /\{\{\s*references\s*\}\}/.test(this.effectiveTemplate(entry));
			let promptWantsRefs = this.willCallProvider(entry, values);
			if (tplWantsRefs || promptWantsRefs) {
				let t = Date.now();
				ctx.references = await getRefs();
				tRefs = Date.now() - t;
			}
		}

		// 1. Champs de type « ai » : chacun a sa propre consigne et ne concerne
		//    que lui. Les champs saisis à la main sont déjà disponibles pour
		//    servir de contexte à ces consignes.
		for (let f of schema) {
			if (f.type !== "ai" || !f.prompt.trim()) continue;
			if (String(values[f.name] || "").trim()) continue;
			try {
				let t = Date.now();
				values[f.name] = await this.generateComment({
					text, ctx, color, comment, fields: values, promptOverride: f.prompt
				});
				tAI += Date.now() - t;
			}
			catch (e) {
				log("champ IA « " + f.name + " » : " + e);
				values[f.name] = "";
			}
		}

		// 2. Le prompt de la couleur renseigne les champs restés vides — et eux
		//    seuls. C'est le lien entre les deux réglages : la réponse est
		//    contrainte aux champs déclarés, pas un commentaire libre. Ce que
		//    vous avez tapé à la main n'est jamais réécrit ; si vous avez tout
		//    rempli, aucun appel n'est fait.
		if (this.entryFillsFields(entry)) {
			let toFill = this.fieldsToFill(schema, values);
			if (toFill.length) {
				try {
					let t = Date.now();
					let json = this.supportsJSON();
					let reply = await this.generateComment({
						text, ctx, color, comment, fields: values, json,
						promptOverride: entry.prompt + "\n" + (json
							? this.buildFieldInstructionJSON(toFill, schema, values)
							: this.buildFieldInstruction(toFill, schema, values))
					});
					tAI += Date.now() - t;
					// Le JSON demandé n'est pas garanti : un petit modèle local
					// répond parfois en texte. On relit alors comme avant plutôt
					// que de perdre la réponse.
					let parsed = json ? this.parseJSONReply(reply, toFill) : null;
					if (!parsed) {
						if (json) log("réponse non-JSON : relecture « nom: valeur »");
						parsed = this.parseFieldReply(reply, toFill);
					}
					Object.assign(values, parsed);
				}
				catch (e) {
					log("remplissage des champs par l'IA : " + e);
					throw e;
				}
			}
		}

		// 3. Réponse d'IA pour le commentaire ENTIER : uniquement si la
		//    disposition la réclame ({{ai}}) ou s'il n'y a ni champs ni gabarit.
		//    Une couleur dotée de champs se passe donc du modèle par défaut,
		//    même si un prompt est encore renseigné.
		let ai = "";
		if (this.entryNeedsAI(entry)) {
			if (!entry.prompt.trim()) return null;   // rien à demander au modèle
			let t = Date.now();
			ai = await this.generateComment({ text, ctx, color, comment, fields: values });
			tAI += Date.now() - t;
		}

		// Publié pour le relevé de handleItem : « refs » = ouverture du PDF et
		// résolution des citations, « ia » = attente du modèle.
		this._timings = { refs: tRefs, ai: tAI, build: Date.now() - t0 };

		let tpl = this.effectiveTemplate(entry);
		if (!tpl) return ai;

		let vars = this.buildVars({ text, ctx, comment, fields: values });
		vars.ai = ai;
		return this.renderTemplate(tpl, vars);
	},

	// ---- Apple Intelligence (modèle embarqué de macOS) ----
	//
	// macOS 26+ expose le modèle Apple Intelligence via le framework
	// FoundationModels, accessible uniquement depuis du code Swift : il n'existe
	// ni endpoint HTTP ni CLI fourni. Annota écrit donc un petit programme Swift,
	// le compile UNE FOIS (~1 s) dans le répertoire de données Zotero, puis
	// réutilise le binaire (~1-2 s par appel). Tout reste sur la machine.
	APPLE_SWIFT_SOURCE: [
		"import Foundation",
		"import FoundationModels",
		"",
		"let instructions = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : \"\"",
		"let prompt = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? \"\"",
		"",
		"guard case .available = SystemLanguageModel.default.availability else {",
		"    FileHandle.standardError.write(\"Apple Intelligence unavailable on this Mac\\n\".data(using: .utf8)!)",
		"    exit(2)",
		"}",
		"",
		"let sem = DispatchSemaphore(value: 0)",
		"var out = \"\", err = \"\"",
		"Task {",
		"    do {",
		"        let session = instructions.isEmpty",
		"            ? LanguageModelSession()",
		"            : LanguageModelSession(instructions: instructions)",
		"        let r = try await session.respond(to: prompt)",
		"        out = r.content",
		"    } catch {",
		"        err = \"\\(error)\"",
		"    }",
		"    sem.signal()",
		"}",
		"sem.wait()",
		"if !err.isEmpty {",
		"    FileHandle.standardError.write((err + \"\\n\").data(using: .utf8)!)",
		"    exit(1)",
		"}",
		"print(out)"
	].join("\n"),

	// Répertoire où déposer la source et le binaire.
	_appleDir() {
		try {
			if (Zotero.DataDirectory && Zotero.DataDirectory.dir) return Zotero.DataDirectory.dir;
		}
		catch (e) { /* ignore */ }
		return Zotero.getTempDirectory().path;
	},

	// Compile le binaire si nécessaire, renvoie son chemin.
	async ensureAppleBinary(Subprocess) {
		let custom = String(getPref("applePath", "")).trim();
		if (custom) return custom;

		let dir = this._appleDir();
		let bin = PathUtils.join(dir, "annota-apple-ai");
		if (await IOUtils.exists(bin)) return bin;

		let srcPath = PathUtils.join(dir, "annota-apple-ai.swift");
		await IOUtils.writeUTF8(srcPath, this.APPLE_SWIFT_SOURCE);

		let swiftc = String(getPref("swiftcPath", "/usr/bin/swiftc")).trim() || "/usr/bin/swiftc";
		let proc;
		try {
			proc = await Subprocess.call({
				command: swiftc,
				arguments: ["-O", "-o", bin, srcPath],
				stderr: "pipe"
			});
		}
		catch (e) {
			throw new Error("swiftc introuvable (" + swiftc + ") — installez les "
				+ "Xcode Command Line Tools : xcode-select --install");
		}
		let errText = "", c;
		while ((c = await proc.stderr.readString()) !== "") errText += c;
		let { exitCode } = await proc.wait();
		if (exitCode !== 0 || !(await IOUtils.exists(bin))) {
			throw new Error("Compilation Swift échouée : "
				+ (errText.trim() || "code " + exitCode).slice(0, 300));
		}
		log("Binaire Apple Intelligence compilé : " + bin);
		return bin;
	},

	async callApple({ system, user }) {
		let Subprocess;
		try {
			({ Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs"));
		}
		catch (e) {
			throw new Error("Subprocess indisponible : " + (e.message || e));
		}

		let bin = await this.ensureAppleBinary(Subprocess);
		let proc = await Subprocess.call({
			command: bin,
			arguments: system ? [system] : [],
			stderr: "pipe"
		});

		let killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 120000);
		try {
			await proc.stdin.write(user);
			await proc.stdin.close();

			let out = "", chunk;
			while ((chunk = await proc.stdout.readString()) !== "") out += chunk;
			let errText = "", ce;
			while ((ce = await proc.stderr.readString()) !== "") errText += ce;

			let { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new Error("Apple Intelligence (code " + exitCode + ") : "
					+ (errText.trim() || "pas de détail").slice(0, 300));
			}
			if (!out.trim()) throw new Error("Réponse vide d'Apple Intelligence");
			return this.sanitize(out);
		}
		finally {
			clearTimeout(killTimer);
		}
	},

	// Claude Code CLI local (`claude -p`). Utilise l'abonnement connecté du CLI,
	// pas l'API facturée au token. Aucune clé API : l'authentification est celle
	// de `claude` sur la machine. Lent (démarrage à froid par appel).
	async callCLI({ system, user }) {
		let Subprocess;
		try {
			({ Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs"));
		}
		catch (e) {
			throw new Error("Subprocess indisponible : " + (e.message || e));
		}

		let cmd = String(getPref("cliPath", "claude")).trim() || "claude";
		let model = String(getPref("cliModel", "")).trim();
		let args = ["-p", "--output-format", "text"];
		if (model) args.push("--model", model);
		if (system) args.push("--append-system-prompt", system);

		// Répertoire de travail neutre : évite de charger un CLAUDE.md de projet.
		let workdir;
		try { workdir = Zotero.getTempDirectory().path; } catch (e) { workdir = undefined; }

		let proc;
		try {
			proc = await Subprocess.call({
				command: cmd,
				arguments: args,
				workdir,
				stderr: "pipe"
			});
		}
		catch (e) {
			throw new Error("Impossible de lancer le CLI « " + cmd + " » : " + (e.message || e));
		}

		// Garde-fou : tuer le process s'il dépasse le délai (ex. non connecté).
		let killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 120000);
		try {
			await proc.stdin.write(user);
			await proc.stdin.close();

			let out = "", chunk;
			while ((chunk = await proc.stdout.readString()) !== "") out += chunk;
			let errText = "", ce;
			while ((ce = await proc.stderr.readString()) !== "") errText += ce;

			let { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new Error("CLI code " + exitCode + " : "
					+ (errText.trim() || "(pas de sortie d'erreur)").slice(0, 300));
			}
			if (!out.trim()) throw new Error("Réponse vide du CLI");
			return this.sanitize(out);
		}
		finally {
			clearTimeout(killTimer);
		}
	},

	// Fournisseur compatible OpenAI (Mistral par défaut).
	async callOpenAI({ system, user }, opts = {}) {
		let cfg = this.chatConfig();
		if (cfg.requiresKey && !cfg.apiKey) throw new Error("API key missing");
		if (!cfg.endpoint) throw new Error("Endpoint not set");
		let temp = parseFloat(getPref("temperature", 0.2));
		if (isNaN(temp)) temp = 0.2;
		temp = Math.max(0, Math.min(2, temp));

		let messages = system
			? [{ role: "system", content: system }, { role: "user", content: user }]
			: [{ role: "user", content: user }];

		let headers = { "Content-Type": "application/json" };
		// Ollama ignore l'autorisation : on n'envoie l'en-tête que si une clé existe.
		if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;

		let payload = { model: cfg.model, temperature: temp, messages, stream: false };
		// Sortie structurée : le modèle rend un objet JSON au lieu d'un texte
		// libre qu'il faut relire à la regex. Mistral et Ollama l'acceptent.
		if (opts.json) payload.response_format = { type: "json_object" };

		let resp = await this.httpJSON(cfg.endpoint, headers, payload);

		let data = resp.response;
		let content = data && data.choices && data.choices[0]
			&& data.choices[0].message && data.choices[0].message.content;
		if (!content) throw new Error("Empty API response");
		return this.sanitize(content);
	},

	// POST JSON commun, avec message d'erreur lisible.
	async httpJSON(url, headers, payload) {
		// Un modèle local doit d'abord être chargé en mémoire : délai plus large.
		let timeout = this.provider() === "ollama" ? 180000 : 45000;
		try {
			return await Zotero.HTTP.request("POST", url, {
				headers,
				body: JSON.stringify(payload),
				responseType: "json",
				timeout
			});
		}
		catch (e) {
			let status = e && e.xmlhttp ? e.xmlhttp.status : "?";
			let raw = "";
			try { raw = e.xmlhttp ? e.xmlhttp.responseText : ""; } catch (e2) {}

			// Extraire le message de l'API plutôt que d'afficher le JSON brut :
			// « model 'llama3.1' not found » est autrement noyé dans l'objet.
			let msg = "";
			try {
				let d = JSON.parse(raw);
				msg = (d && d.error && (d.error.message || d.error))
					|| (d && d.message) || "";
				if (typeof msg !== "string") msg = JSON.stringify(msg);
			}
			catch (e2) { /* pas du JSON */ }
			if (!msg) msg = raw.slice(0, 200);

			// Aide ciblée sur les deux échecs Ollama les plus fréquents.
			if (this.provider() === "ollama") {
				if (/not found/i.test(msg)) {
					msg += " — pick an installed model in Preferences → Annota "
						+ "(tags matter: « llama3.1:8b », not « llama3.1 »).";
				}
				else if (!status || status === 0) {
					msg = "Ollama unreachable — is it running? (" + msg + ")";
				}
			}
			// Le statut est porté par l'erreur : décider de réessayer sur le
			// libellé serait dépendre d'une chaîne de caractères, alors que
			// « 401 » est une donnée.
			let err = new Error("API (HTTP " + status + ") " + msg);
			err.status = (typeof status === "number") ? status : 0;
			throw err;
		}
	},

	// ---- Traitement a posteriori (menu contextuel) ----

	// Rassemble les annotations éligibles à partir d'une sélection : items
	// classiques, pièces jointes, ou annotations sélectionnées directement.
	async collectAnnotations(items) {
		let out = [];
		let seen = new Set();

		let push = (ann) => {
			if (ann && !seen.has(ann.id)) { seen.add(ann.id); out.push(ann); }
		};

		for (let item of items) {
			try {
				if (item.isAnnotation && item.isAnnotation()) { push(item); continue; }

				let attachments = [];
				if (item.isAttachment && item.isAttachment()) {
					attachments = [item];
				}
				else if (item.isRegularItem && item.isRegularItem()) {
					let ids = item.getAttachments();
					attachments = await Zotero.Items.getAsync(ids);
				}

				for (let att of attachments) {
					if (!att || !att.isFileAttachment || !att.isFileAttachment()) continue;
					for (let ann of att.getAnnotations()) push(ann);
				}
			}
			catch (e) {
				log("collectAnnotations: " + e);
			}
		}
		return out;
	},

	// Annotation traitable ? (type ciblé, texte non vide, bibliothèque modifiable)
	isEligible(ann, overwrite, failedOnly) {
		if (!ann || !ann.isAnnotation || !ann.isAnnotation()) return false;
		if (!this.targetTypes().includes(ann.annotationType)) return false;
		if (ann.library && ann.library.editable === false) return false;
		if (!(ann.annotationText || "").trim()) return false;
		// « Rejouer les échecs » ne regarde que les annotations marquées, et les
		// reprend quel que soit leur commentaire — c'est bien un remplacement.
		if (failedOnly) return this.hasFailedTag(ann);
		if ((ann.annotationComment || "").trim() && !overwrite) return false;
		return true;
	},

	// Lance la génération sur la sélection courante de la fenêtre.
	// Volontairement indépendant de la préférence « enabled » : l'action est explicite.
	async runBatch(window, opts = {}) {
		let overwrite = !!opts.overwrite;

		let notReady = this.providerReadyError();
		if (notReady) {
			toast("Annota", notReady, "error");
			return;
		}

		let selected;
		try {
			selected = window.ZoteroPane.getSelectedItems();
		}
		catch (e) {
			log("runBatch: sélection illisible : " + e);
			return;
		}
		if (!selected || !selected.length) return;

		let all = await this.collectAnnotations(selected);
		return this.processAnnotations(all, opts);
	},

	// Traitement commun : bibliothèque (menu contextuel) et lecteur (annotation
	// ciblée). `all` = annotations candidates, déjà collectées.
	async processAnnotations(all, opts = {}) {
		let overwrite = !!opts.overwrite || !!opts.failedOnly;
		let eligible = all.filter(a => this.isEligible(a, overwrite, opts.failedOnly));

		// Les couleurs sans prompt sont ignorées : on les compte à part pour
		// pouvoir l'expliquer, sinon l'absence de résultat serait incompréhensible.
		let targets = [];
		let noPrompt = 0;
		for (let a of eligible) {
			// getColorEntry, pas getPromptForColor : une couleur peut être active
			// avec un gabarit ou des champs seuls (commentaire déterministe).
			if (this.getColorEntry(a.annotationColor)) targets.push(a);
			else noPrompt++;
		}

		if (!targets.length) {
			let why;
			if (noPrompt) {
				why = noPrompt + " highlight" + (noPrompt > 1 ? "s" : "")
					+ " skipped — their color has no prompt yet (Preferences → Annota).";
			}
			else if (opts.failedOnly) {
				why = "Nothing to retry — no annotation is marked as failed.";
			}
			else if (all.length) {
				why = "Nothing to do — all annotations already have comments.";
			}
			else {
				why = "No highlight annotations found in the selection.";
			}
			toast("Annota", why);
			return;
		}

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Annota");
		let bar = new pw.ItemProgress(
			"chrome://zotero/skin/tick.png",
			"Generating 0/" + targets.length + "…"
		);
		pw.show();

		let ok = 0, failed = 0;
		for (let i = 0; i < targets.length; i++) {
			let ann = targets[i];
			try {
				let annText = (ann.annotationText || "").trim();
				let ctx = this.getContext(ann);
				// Le menu contextuel traite toutes les couleurs ayant un prompt,
				// « auto » ou « manuel ». Le commentaire existant (paraphrase
				// manuelle) est transmis via {{comment}}.
				let comment = await this.buildComment({
					text: annText,
					ctx,
					color: ann.annotationColor,
					comment: (ann.annotationComment || "").trim(),
					fields: opts.fields,
					getRefs: () => this.getReferences(ann, annText)
				});
				if (comment === null || !String(comment).trim()) {
					failed++;
					await this.markFailed(ann.id, "résultat vide");
					continue;
				}
				let fresh = await Zotero.Items.getAsync(ann.id);
				if (fresh) {
					fresh.annotationComment = comment;
					this.setFailedTag(fresh, false);
					await fresh.saveTx();
					ok++;
				}
			}
			catch (e) {
				failed++;
				log("runBatch item " + ann.id + " : " + e);
				await this.markFailed(ann.id, String(e.message || e));
			}
			bar.setProgress(Math.round(((i + 1) / targets.length) * 100));
			bar.setText("Generating " + (i + 1) + "/" + targets.length + "…");
		}

		bar.setProgress(100);
		let summary = ok + " comment" + (ok > 1 ? "s" : "") + " generated";
		if (failed) {
			let tag = this.failedTag();
			summary += ", " + failed + " failed"
				+ (tag ? " (tagged “" + tag + "”)" : " (see debug output)");
		}
		if (noPrompt) summary += ", " + noPrompt + " skipped (color has no prompt)";
		bar.setText(summary);
		pw.startCloseTimer(failed ? 8000 : 4000);
		log("runBatch terminé : " + ok + " ok, " + failed + " échecs, "
			+ noPrompt + " sans prompt");
	},

	// ---- Formulaire de champs dans le popup de sélection ----
	//
	// Hook officiel « renderTextSelectionPopup » : la fenêtre qui apparaît quand
	// on sélectionne du texte, AVANT que l'annotation existe. On y saisit les
	// champs, puis on valide en choisissant une couleur de surlignage dans le
	// popup de Zotero ; l'annotation créée récupère les valeurs.
	//
	// Cliquer une pastille CRÉE l'annotation : il n'existe pas d'étape « choisir
	// la couleur puis valider ». On n'affiche donc pas la couleur retenue, on
	// affiche celle que vous vous apprêtez à cliquer — le survol des pastilles
	// de Zotero pilote le groupe de champs. À défaut, nos propres pastilles.

	_selectionListener: null,
	_pendingFields: null,          // { text, values, ts, color }
	_lastColor: null,              // dernière couleur réellement traitée

	// Union des champs de toutes les couleurs, dédoublonnée par nom.
	// Conservée comme repli quand aucune couleur n'est désignable.
	allFieldsSchema() {
		let seen = new Set(), out = [];
		for (let c of this.COLORS) {
			for (let f of this.fieldsForColor(c.hex)) {
				if (seen.has(f.name)) continue;
				seen.add(f.name);
				out.push(f);
			}
		}
		return out;
	},

	// Champs saisissables d'une couleur (les champs « ai » sont écrits par le
	// modèle, jamais par vous).
	visibleFieldsFor(hex) {
		return this.fieldsForColor(hex).filter(f => f.type !== "ai");
	},

	// Couleurs ayant au moins un champ à saisir.
	colorsWithFields() {
		return this.COLORS.filter(c => this.visibleFieldsFor(c.hex).length);
	},

	// Groupe affiché tant qu'aucune pastille n'a été désignée : la dernière
	// couleur utilisée, parce qu'on surligne rarement une seule fois.
	defaultFieldColor() {
		let withFields = this.colorsWithFields();
		if (!withFields.length) return null;
		if (this._lastColor && withFields.some(c => c.hex === this._lastColor)) {
			return this._lastColor;
		}
		return withFields[0].hex;
	},

	// Pastilles du popup de Zotero. selection-popup.js les rend dans
	// « .colors > .color-button », au même index que ANNOTATION_COLORS — donc au
	// même index que Zotero.Annotations.COLORS, d'où notre propre liste. Nos
	// champs étant injectés dans ce popup (CustomSections), on remonte jusqu'à
	// lui. Un nombre de boutons inattendu = version qu'on ne sait pas lire :
	// on renvoie null plutôt que d'associer des couleurs au hasard.
	readerColorButtons(node) {
		try {
			let root = node && node.parentNode;
			while (root && !(root.classList
					&& root.classList.contains && root.classList.contains("selection-popup"))) {
				root = root.parentNode;
			}
			if (!root || typeof root.querySelectorAll !== "function") return null;
			let btns = Array.prototype.slice.call(
				root.querySelectorAll(".colors .color-button"));
			return btns.length === this.COLORS.length ? btns : null;
		}
		catch (e) {
			log("readerColorButtons: " + e);
			return null;
		}
	},

	// Valeurs mises de côté pour un passage donné (validité : 10 minutes).
	// Zotero normalise le texte à l'enregistrement (retours à la ligne, césures,
	// espaces) : une égalité stricte avec le texte vu au moment de la sélection
	// échoue presque toujours. On compare donc une forme normalisée, puis un
	// préfixe, et à défaut on retient une saisie très récente — le geste étant
	// « je tape puis je clique une couleur » dans la foulée.
	_normText(t) {
		return String(t || "")
			.replace(/[\u00AD]/g, "")          // césures conditionnelles
			.replace(/-\s*\n\s*/g, "")         // mots coupés en fin de ligne
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	},

	// consume=false : consulter sans effacer (pour décider s'il faut agir).
	_matchPending(text, consume) {
		let p = this._pendingFields;
		if (!p) return null;
		let age = Date.now() - p.ts;
		if (age > 600000) { this._pendingFields = null; return null; }

		let a = this._normText(p.text), b = this._normText(text);
		let how = "";
		if (a && b && a === b) how = "texte identique";
		else if (a && b && (a.startsWith(b.slice(0, 40)) || b.startsWith(a.slice(0, 40)))) {
			how = "préfixe commun";
		}
		else if (age < 60000) how = "saisie récente (" + Math.round(age / 1000) + " s)";

		if (!how) {
			log("champs en attente non appliqués : le passage ne correspond pas");
			return null;
		}
		if (consume) {
			this._pendingFields = null;   // consommé une seule fois
			log("champs appliqués (" + how + ")");
		}
		return p.values;
	},

	peekPendingFields(text) { return this._matchPending(text, false); },
	takePendingFields(text) { return this._matchPending(text, true); },

	// Y a-t-il au moins une valeur non vide ? Un formulaire laissé vierge ne
	// doit pas déclencher une génération sur une couleur « à la demande ».
	_hasFilledValues(values) {
		return !!values && Object.keys(values).some(k => String(values[k] || "").trim());
	},

	registerSelectionForm() {
		try {
			if (!Zotero.Reader || !Zotero.Reader.registerEventListener) return;
			this._selectionListener = (event) => {
				try { this._renderSelectionForm(event); }
				catch (e) { log("renderTextSelectionPopup: " + e); }
			};
			Zotero.Reader.registerEventListener(
				"renderTextSelectionPopup", this._selectionListener, "annota@equiriconi");
			log("Formulaire de sélection enregistré");
		}
		catch (e) {
			log("registerSelectionForm: " + e);
		}
	},

	unregisterSelectionForm() {
		try {
			if (this._selectionListener && Zotero.Reader
					&& Zotero.Reader.unregisterEventListener) {
				Zotero.Reader.unregisterEventListener(
					"renderTextSelectionPopup", this._selectionListener);
			}
		}
		catch (e) { /* ignore */ }
		this._selectionListener = null;
	},

	// Le lecteur de Zotero réserve des touches SEULES à ses raccourcis : « r » et
	// « l » lancent la lecture vocale, « h » et « u » annotent, l'espace met en
	// pause. Il les écoute en PHASE DE CAPTURE sur la fenêtre
	// (keyboard-manager.js : addEventListener('keydown', …, true)), donc bien
	// avant que la frappe n'atteigne nos champs : aucun stopPropagation posé
	// sur le formulaire ne peut arriver à temps.
	//
	// Sa seule échappatoire est le test isTextBox(event.target), qui vaut
	// (lib/utilities.js) :
	//     ['INPUT'].includes(node.nodeName) && node.type === 'text'
	//         || node.getAttribute('contenteditable') === 'true'
	//
	// Autrement dit un <input type="text"> est épargné, mais PAS un
	// <textarea>, ni un <select>, ni une case à cocher — d'où une lecture
	// vocale déclenchée en tapant une paraphrase contenant un « r », et jamais
	// en remplissant le titre. On coche donc la seconde condition : l'attribut
	// contenteditable est inerte sur un contrôle de formulaire, mais il suffit
	// à faire reconnaître le champ comme zone de saisie.
	// Suppr / Retour arrière SUPPRIMENT l'annotation sélectionnée. Le garde-fou
	// est ici différent de celui des lettres (keyboard-manager.js) :
	//     if (event.target.closest('input, .label-popup') || …) return;
	// « input » couvre nos champs texte et nos cases à cocher, mais PAS un
	// <textarea> — donc corriger une faute dans une paraphrase effaçait le
	// surlignage précédent, resté sélectionné.
	//
	// La seule accroche disponible est donc la classe .label-popup, portée par
	// le conteneur du formulaire : closest() la trouve depuis n'importe quel
	// champ. Elle vient avec sa mise en forme (position:absolute, left:-9999px,
	// padding:16px, pointeur en pseudo-éléments) qui expédierait le formulaire
	// hors écran : on la neutralise par une feuille de style à nous. Aucun
	// effet de bord ailleurs — focus-manager.js teste .selection-popup, que
	// notre conteneur satisfait déjà par son emplacement.
	FORM_CLASS: "label-popup annota-fields",

	_ensureFormStyles(doc) {
		try {
			if (!doc || typeof doc.getElementById !== "function") return;
			if (doc.getElementById("annota-form-style")) return;
			let st = doc.createElement("style");
			st.id = "annota-form-style";
			st.textContent = ".annota-fields{position:static !important;"
				+ "left:auto !important;top:auto !important;right:auto !important;"
				+ "bottom:auto !important;padding:0 !important;margin:0 !important;}"
				+ ".annota-fields::before,.annota-fields::after{"
				+ "content:none !important;display:none !important;}";
			let host = doc.head || doc.documentElement;
			if (host && host.appendChild) host.appendChild(st);
		}
		catch (e) {
			log("_ensureFormStyles: " + e);
		}
	},

	_shieldFromReaderShortcuts(el, type) {
		if (type === "text") return;      // déjà reconnu tel quel
		try { el.setAttribute("contenteditable", "true"); }
		catch (e) { /* ignore */ }
	},

	_renderSelectionForm({ doc, params, append }) {
		if (!doc || !append) return;
		let colors = this.colorsWithFields();
		if (!colors.length) return;
		let text = String((params && params.annotation && params.annotation.text) || "").trim();
		if (!text) return;

		// Le popup peut être re-rendu pendant la sélection, et l'on passe d'un
		// groupe à l'autre : les valeurs déjà tapées survivent aux deux.
		let values = (this._pendingFields && this._pendingFields.text === text)
			? Object.assign({}, this._pendingFields.values) : {};
		let current = (this._pendingFields && this._pendingFields.text === text
				&& this._pendingFields.color)
			? this._pendingFields.color : this.defaultFieldColor();

		// Pas de largeur imposée : le formulaire épouse le popup. Un min-width
		// débordait du cadre, les champs sortaient de la fenêtre.
		this._ensureFormStyles(doc);
		let wrap = doc.createElement("div");
		// Voir FORM_CLASS : c'est ce qui empêche Suppr d'effacer l'annotation.
		wrap.setAttribute("class", this.FORM_CLASS);
		wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"
			+ "width:100%;max-width:100%;box-sizing:border-box;padding:2px 0;";

		// Filet secondaire : arrête les écouteurs de PHASE REMONTANTE. Insuffisant
		// à lui seul contre le lecteur (voir _shieldFromReaderShortcuts), mais
		// utile face au reste de Zotero.
		for (let type of ["keydown", "keypress", "keyup"]) {
			wrap.addEventListener(type, e => e.stopPropagation());
		}

		// Style commun, aligné sur le thème du lecteur (couleurs héritées).
		const FIELD_CSS = "width:100%;max-width:100%;box-sizing:border-box;"
			+ "font:inherit;font-size:12px;line-height:1.3;padding:4px 6px;"
			+ "border:1px solid rgba(128,128,128,.45);border-radius:4px;"
			+ "background:rgba(128,128,128,.12);color:inherit;outline:none;";
		const LABEL_CSS = "font-size:11px;opacity:.65;";

		let header = doc.createElement("div");     // libellé de la couleur en cours
		header.style.cssText = "display:none;align-items:center;gap:5px;width:100%;"
			+ "font-size:11px;font-weight:600;letter-spacing:.01em;";
		let picker = doc.createElement("div");     // repli : nos propres pastilles
		picker.style.cssText = "display:none;align-items:center;gap:4px;"
			+ "flex-wrap:wrap;width:100%;";
		let body = doc.createElement("div");       // groupe de champs courant
		body.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;";
		let hint = doc.createElement("div");
		hint.style.cssText = "display:flex;align-items:center;justify-content:center;"
			+ "gap:5px;font-size:10px;line-height:1.3;text-align:center;";
		wrap.appendChild(picker);
		wrap.appendChild(header);
		wrap.appendChild(body);
		wrap.appendChild(hint);

		const colorName = (hex) => {
			let c = this.COLORS.find(x => x.hex === hex);
			return c ? c.name : hex;
		};

		// Le pied du formulaire nomme la pastille à cliquer, et la montre : dans
		// une rangée de huit ronds, une couleur se reconnaît plus vite qu'elle
		// ne se lit. Il sert aussi à dire qu'une couleur n'a rien de configuré,
		// plutôt que de laisser un formulaire vide sans explication.
		const SWATCH_CSS = "width:9px;height:9px;flex:none;border-radius:2px;"
			+ "display:inline-block;border:1px solid rgba(128,128,128,.55);";

		// Le libellé nomme ce qu'on est en train de faire (« Objection »), quand
		// le pied nomme la pastille à cliquer (« Red ») : deux informations
		// différentes. Sans libellé, l'en-tête disparaît — le popup est étroit.
		const renderHeader = (hex) => {
			let label = this.labelForColor(hex);
			header.textContent = "";
			if (!label) { header.style.display = "none"; return; }
			header.style.display = "flex";
			let sw = doc.createElement("span");
			sw.style.cssText = SWATCH_CSS + "background:" + hex + ";";
			let txt = doc.createElement("span");
			txt.textContent = label;
			header.appendChild(sw);
			header.appendChild(txt);
		};

		const renderHint = (hex, configured) => {
			hint.textContent = "";
			let sw = doc.createElement("span");
			sw.style.cssText = SWATCH_CSS + "background:" + hex + ";";
			let msg = doc.createElement("span");
			msg.textContent = configured
				? "Click " + colorName(hex) + " above to save"
				: colorName(hex) + " — no fields configured";
			hint.style.opacity = configured ? "0.6" : "0.85";
			hint.appendChild(sw);
			hint.appendChild(msg);
		};

		// Mémorisé au fil de la frappe : la validation se fait ensuite en
		// cliquant une couleur dans le popup de Zotero.
		const sync = () => {
			this._pendingFields = { text, values, ts: Date.now(), color: current };
		};

		const renderGroup = (hex) => {
			current = hex;
			body.textContent = "";
			let fields = this.visibleFieldsFor(hex);
			for (let f of fields) {
				let row = doc.createElement("div");
				let lab = doc.createElement("label");
				lab.textContent = f.label;
				let el;

				if (f.type === "check") {
					// Case à cocher : libellé à droite, sur une seule ligne.
					row.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;";
					el = doc.createElement("input");
					el.type = "checkbox";
					el.style.cssText = "margin:0;flex:none;";
					if (values[f.name]) el.checked = true;
					lab.style.cssText = "font-size:12px;opacity:.85;";
					row.appendChild(el);
					row.appendChild(lab);
				}
				else {
					row.style.cssText = "display:flex;flex-direction:column;gap:2px;width:100%;";
					lab.style.cssText = LABEL_CSS;
					if (f.type === "textarea") {
						el = doc.createElement("textarea");
						el.rows = 2;
						el.style.cssText = FIELD_CSS + "resize:vertical;min-height:38px;";
					}
					else if (f.type === "select") {
						el = doc.createElement("select");
						for (let o of [""].concat(f.options)) {
							let opt = doc.createElement("option");
							opt.value = o;
							opt.textContent = o || "—";
							el.appendChild(opt);
						}
						el.style.cssText = FIELD_CSS;
					}
					else {
						el = doc.createElement("input");
						el.type = "text";
						el.style.cssText = FIELD_CSS;
					}
					if (values[f.name] !== undefined) el.value = values[f.name];
					row.appendChild(lab);
					row.appendChild(el);
				}

				this._shieldFromReaderShortcuts(el, f.type);
				// Chaque champ écrit dans le tampon commun : ce qui est tapé pour
				// une couleur n'est pas perdu si l'on regarde une autre.
				let read = (f.type === "check")
					? () => (el.checked ? "true" : "")
					: () => String(el.value || "");
				let onEdit = () => { values[f.name] = read(); sync(); };
				el.addEventListener("input", onEdit);
				el.addEventListener("change", onEdit);
				body.appendChild(row);
			}
			renderHeader(hex);
			renderHint(hex, fields.length > 0);
			sync();
		};

		append(wrap);

		// Voie normale : le survol des pastilles de Zotero désigne la couleur.
		// Aucun clic supplémentaire — le geste reste « je survole, je tape, je
		// clique ». Le clic, lui, appartient à Zotero : il crée l'annotation.
		let btns = this.readerColorButtons(wrap);
		if (btns) {
			this.COLORS.forEach((c, i) => {
				let btn = btns[i];
				if (!btn) return;
				// Y compris les couleurs sans champ : le survol répond alors
				// « rien de configuré » au lieu de laisser le groupe précédent,
				// ce qui laissait croire que ces champs seraient enregistrés.
				let show = () => { if (current !== c.hex) renderGroup(c.hex); };
				btn.addEventListener("mouseenter", show);
				btn.addEventListener("focus", show);   // navigation au clavier
			});
			log("groupes de champs pilotés par les pastilles du lecteur");
		}
		else {
			// Repli : structure du popup non reconnue. Plutôt que de deviner,
			// on affiche nos propres pastilles.
			picker.style.display = "flex";
			let lab = doc.createElement("span");
			lab.textContent = "Fields:";
			lab.style.cssText = "font-size:11px;opacity:.6;";
			picker.appendChild(lab);
			for (let c of colors) {
				let sw = doc.createElement("button");
				sw.type = "button";
				sw.title = c.name;
				sw.style.cssText = "width:14px;height:14px;padding:0;flex:none;"
					+ "border-radius:50%;border:1px solid rgba(128,128,128,.5);"
					+ "cursor:pointer;background:" + c.hex + ";";
				sw.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					renderGroup(c.hex);
				});
				picker.appendChild(sw);
			}
			log("pastilles du lecteur non reconnues : sélecteur de repli affiché");
		}

		renderGroup(current);
	},

	// ---- Menu contextuel des annotations du lecteur ----
	//
	// API officielle de Zotero (reader.js) : registerEventListener avec le type
	// « createAnnotationContextMenu ». Permet de viser UNE annotation précise
	// depuis le panneau latéral, plutôt que tout un document.
	// params.ids contient des CLÉS d'items (reader.js : annotation.key =
	// annotation.id), pas des identifiants numériques.

	_readerListener: null,

	registerReaderMenu() {
		try {
			if (!Zotero.Reader || !Zotero.Reader.registerEventListener) return;
			this._readerListener = (event) => {
				try {
					let { reader, params, append } = event;
					let keys = (params && params.ids) || [];
					if (!keys.length) return;
					append({
						label: keys.length > 1
							? "Annota — generate " + keys.length + " comments"
							: "Annota — generate comment",
						onCommand: () => {
							Annota.runOnReaderAnnotations(reader, keys)
								.catch(e => log("runOnReaderAnnotations: " + e));
						}
					});
				}
				catch (e) {
					log("createAnnotationContextMenu: " + e);
				}
			};
			Zotero.Reader.registerEventListener(
				"createAnnotationContextMenu", this._readerListener, "annota@equiriconi");
			log("Menu du lecteur enregistré");
		}
		catch (e) {
			log("registerReaderMenu: " + e);
		}
	},

	unregisterReaderMenu() {
		try {
			if (this._readerListener && Zotero.Reader
					&& Zotero.Reader.unregisterEventListener) {
				Zotero.Reader.unregisterEventListener(
					"createAnnotationContextMenu", this._readerListener);
			}
		}
		catch (e) { /* ignore */ }
		this._readerListener = null;
	},

	// Exécute le prompt sur les annotations visées dans le lecteur.
	// L'action étant explicite, elle écrase le commentaire existant : c'est ce
	// qui permet d'écrire sa paraphrase à la main puis de la faire mettre en
	// forme (mode « à la demande » + {{comment}}).
	async runOnReaderAnnotations(reader, keys, opts = {}) {
		let notReady = this.providerReadyError();
		if (notReady) {
			toast("Annota", notReady, "error");
			return;
		}
		let anns = [];
		try {
			let att = await Zotero.Items.getAsync(reader.itemID);
			if (!att) return;
			for (let key of keys) {
				let it = await Zotero.Items.getByLibraryAndKeyAsync(att.libraryID, key);
				if (it && it.isAnnotation && it.isAnnotation()) anns.push(it);
			}
		}
		catch (e) {
			log("runOnReaderAnnotations: résolution des clés : " + e);
			return;
		}
		if (!anns.length) return;
		return this.processAnnotations(anns, { overwrite: true, fields: opts.fields });
	},

	// ---- Menu contextuel (une entrée par fenêtre principale) ----

	_windows: new Map(),

	selectionIsRelevant(window) {
		try {
			let items = window.ZoteroPane.getSelectedItems();
			if (!items || !items.length) return false;
			return items.some(i =>
				(i.isAnnotation && i.isAnnotation())
				|| (i.isAttachment && i.isAttachment())
				|| (i.isRegularItem && i.isRegularItem()));
		}
		catch (e) {
			return false;
		}
	},

	addToWindow(window) {
		try {
			if (this._windows.has(window)) return;
			let doc = window.document;
			let itemmenu = doc.getElementById("zotero-itemmenu");
			if (!itemmenu) return;

			let menu = doc.createXULElement("menu");
			menu.id = "annota-itemmenu";
			menu.setAttribute("label", "Annota");

			let popup = doc.createXULElement("menupopup");

			let missing = doc.createXULElement("menuitem");
			missing.setAttribute("label", "Generate missing comments");
			missing.addEventListener("command", () => {
				Annota.runBatch(window, { overwrite: false })
					.catch(e => log("runBatch: " + e));
			});
			popup.appendChild(missing);

			let all = doc.createXULElement("menuitem");
			all.setAttribute("label", "Regenerate all comments");
			all.addEventListener("command", () => {
				Annota.runBatch(window, { overwrite: true })
					.catch(e => log("runBatch: " + e));
			});
			popup.appendChild(all);

			// Reprise ciblée : ne touche que les annotations marquées en échec,
			// pour rattraper une coupure réseau ou un modèle indisponible sans
			// tout régénérer.
			let retry = doc.createXULElement("menuitem");
			retry.setAttribute("label", "Retry failed comments");
			retry.addEventListener("command", () => {
				Annota.runBatch(window, { failedOnly: true })
					.catch(e => log("runBatch: " + e));
			});
			popup.appendChild(retry);

			menu.appendChild(popup);
			itemmenu.appendChild(menu);

			// Masquer l'entrée quand la sélection ne peut porter aucune annotation.
			let onShowing = () => { menu.hidden = !Annota.selectionIsRelevant(window); };
			itemmenu.addEventListener("popupshowing", onShowing);

			this._windows.set(window, { menu, itemmenu, onShowing });
			log("Menu ajouté à la fenêtre");
		}
		catch (e) {
			log("addToWindow: " + e);
		}
	},

	removeFromWindow(window) {
		let rec = this._windows.get(window);
		if (!rec) return;
		try { rec.itemmenu.removeEventListener("popupshowing", rec.onShowing); } catch (e) {}
		try { rec.menu.remove(); } catch (e) {}
		this._windows.delete(window);
	},

	removeFromAllWindows() {
		for (let window of Array.from(this._windows.keys())) {
			this.removeFromWindow(window);
		}
		this._windows.clear();
	},

	// Nettoie la sortie du modèle (retire d'éventuels blocs de code / espaces superflus).
	// Les modèles écrivent en Markdown même quand on le leur interdit. Le
	// commentaire d'une annotation Zotero n'en comprend rien : « **risque** »
	// s'affiche avec ses astérisques. On convertit donc vers les seules balises
	// que Zotero rend — <b>, <i>, <u> — plutôt que de compter sur la consigne.
	demarkdown(s) {
		// Code : les délimiteurs partent, le contenu reste.
		s = s.replace(/`([^`\n]+)`/g, "$1");
		// Gras avant italique : ** doit être consommé avant *.
		s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>");
		s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "$1<b>$2</b>");
		s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<i>$2</i>");
		// Souligné Markdown : bordé de non-mots, sinon « nom_de_champ » y passe.
		s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1<i>$2</i>");
		// Titres et puces : pas de balise équivalente, on garde le texte.
		s = s.replace(/^#{1,6}\s+/gm, "");
		s = s.replace(/^\s*[-*+]\s+/gm, "• ");
		return s;
	},

	// Une valeur entièrement enveloppée dans une balise : le modèle a mis en
	// forme un champ qui a déjà son propre format déclaré. On déshabille — la
	// mise en forme appartient aux réglages, pas à la réponse.
	unwrapWholeTag(v) {
		for (let i = 0; i < 2; i++) {
			let m = String(v).match(/^<(b|i|u)>([\s\S]*)<\/\1>$/);
			if (!m || m[2].includes("</" + m[1] + ">")) break;
			v = m[2].trim();
		}
		return v;
	},

	sanitize(raw) {
		let s = String(raw).trim();
		s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
		s = this.demarkdown(s);
		s = s.replace(/\n{3,}/g, "\n\n").trim();
		return s;
	}
};

// ---- Cycle de vie du plugin (Zotero 7) ----

function install() {}

async function startup({ id, version, rootURI }) {
	Annota.init({ id, version, rootURI });
	Annota.registerNotifier();
	Annota.registerReaderMenu();
	Annota.registerSelectionForm();

	// Exposé pour le script du panneau de préférences (prompt par défaut, reset).
	Zotero.Annota = Annota;

	Zotero.PreferencePanes.register({
		pluginID: "annota@equiriconi",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
		stylesheets: [rootURI + "preferences.css"],
		label: "Annota"
	});

	// Fenêtres déjà ouvertes au moment de l'activation du plugin.
	for (let window of Zotero.getMainWindows()) {
		Annota.addToWindow(window);
	}

	log("Started (v" + version + ")");
}

function onMainWindowLoad({ window }) {
	if (Annota) Annota.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	// Indispensable : conserver une référence à une fenêtre fermée fuirait.
	if (Annota) Annota.removeFromWindow(window);
}

function shutdown() {
	if (Annota) {
		Annota.unregisterNotifier();
		Annota.unregisterReaderMenu();
		Annota.unregisterSelectionForm();
		Annota.removeFromAllWindows();
	}
	try { delete Zotero.Annota; } catch (e) {}
	Annota = undefined;
}

function uninstall() {}
