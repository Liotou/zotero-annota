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
			return raw.trim() ? { prompt: raw, trigger: "auto", template: "" } : null;
		}
		if (typeof raw !== "object") return null;
		let prompt = String(raw.prompt || "");
		let template = String(raw.template || "");
		if (!prompt.trim() && !template.trim()) return null;
		return {
			prompt,
			template,
			trigger: raw.trigger === "manual" ? "manual" : "auto"
		};
	},

	// Le gabarit réclame-t-il une réponse d'IA ?
	// Gabarit vide → oui (la réponse EST le commentaire).
	// Gabarit contenant {{ai}} → oui. Gabarit sans {{ai}} → non (déterministe).
	entryNeedsAI(entry) {
		if (!entry) return false;
		let tpl = entry.template || "";
		return !tpl.trim() || /\{\{\s*ai\s*\}\}/.test(tpl);
	},

	// Prompt configuré pour cette couleur, ou "" si la couleur n'en a pas.
	getPromptForColor(color) {
		let entry = this.getColorEntry(color);
		return entry ? entry.prompt : "";
	},

	// Fournisseur actif : "openai" (Mistral ou tout endpoint compatible),
	// "ollama" (local), "cli" (Claude Code local).
	provider() {
		let p = String(getPref("provider", "")).trim();
		if (p === "openai" || p === "ollama" || p === "cli") return p;
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

		// Mode 1 (automatique) : ne se déclenche que si la couleur a un prompt
		// ET que ce prompt est réglé sur « auto ». Les couleurs « manuel » ne
		// réagissent qu'au menu contextuel. Couleur sans prompt = ignorée.
		let entry = this.getColorEntry(item.annotationColor);
		if (!entry || entry.trigger !== "auto") return;

		// Commentaire déjà saisi (paraphrase manuelle) : capturé avant tout,
		// pour la variable {{comment}} et pour respecter « ne pas écraser ».
		let existing = (item.annotationComment || "").trim();
		let overwrite = getPref("overwrite", false);
		if (existing && !overwrite) return;

		// Un gabarit purement déterministe (sans {{ai}}) n'appelle aucun modèle :
		// inutile d'exiger une clé API ou le CLI dans ce cas.
		if (this.entryNeedsAI(entry)) {
			let notReady = this.providerReadyError();
			if (notReady) {
				toast("Annota", notReady, "error");
				return;
			}
		}

		this.inProgress.add(id);
		let usedPlaceholder = false;
		try {
			if (getPref("showPlaceholder", true) && this.entryNeedsAI(entry)) {
				item.annotationComment = PLACEHOLDER;
				await item.saveTx();
				usedPlaceholder = true;
			}

			let ctx = this.getContext(item);
			ctx.references = await this.getReferences(item, text);
			let comment = await this.buildComment({
				text, ctx, color: item.annotationColor, comment: existing
			});
			if (comment === null) return;

			// Recharger l'item au cas où il aurait changé pendant l'appel réseau.
			let fresh = await Zotero.Items.getAsync(id);
			if (!fresh) return;
			fresh.annotationComment = comment;
			await fresh.saveTx();
			log("Comment generated for annotation " + id);
		}
		catch (e) {
			log("Generation error: " + e);
			toast("Annota", "Generation failed: " + (e.message || e), "error");
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

	// Coupe une entrée trop longue proprement.
	_trimEntry(s, max = 320) {
		s = String(s).replace(/\s+/g, " ").trim();
		if (s.length <= max) return s;
		let cut = s.slice(0, max);
		let dot = cut.lastIndexOf(". ");
		return dot > max * 0.5 ? cut.slice(0, dot + 1) : cut.trim() + "…";
	},

	// Entrées numérotées : « [12] Auteur… » ou « 12. Auteur… »
	resolveNumericRefs(bib, numbers) {
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
			let body = this._trimEntry(bib.slice(markers[i].start, end));
			if (body.length > 15) {
				out.push("[" + markers[i].n + "] " + body);
				wanted.delete(markers[i].n);
			}
		}
		return out;
	},

	// Entrées auteur-année : fenêtre autour du nom suivi de l'année.
	resolveAuthorYearRefs(bib, pairs) {
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
				// Fin d'entrée = début de l'entrée suivante (« Nom, P. » en début
				// de ligne). Ne PAS couper au premier point : il tombe juste après
				// « (1999). » et amputerait le titre et la revue.
				let next = found.search(/\n\s*\p{Lu}[\p{L}'’-]+,\s+\p{Lu}\./u);
				let body = this._trimEntry(next > 40 ? found.slice(0, next) : found);
				if (body.length > 15) out.push("(" + author + ", " + year + ") → " + body);
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
				txt = this._trimEntry(txt);
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

	// Orchestrateur : liens internes du PDF d'abord (déterministe, même principe
	// que le popup de Zotero), analyse du texte en repli.
	async getReferences(item, text) {
		if (!getPref("resolveCitations", true)) return "";
		try {
			let max = parseInt(getPref("maxRefs", 8), 10) || 8;

			// 1. Voie sûre : suivre les liens du PDF.
			let linked = await this.getLinkedReferences(item);
			if (linked.length) return linked.slice(0, max).join("\n");

			// 2. Repli : détecter les appels et chercher dans la bibliographie.
			let markers = this.detectCitationMarkers(text);
			if (!markers.numbers.length && !markers.authorYears.length) return "";

			let fullText = await this.getAttachmentFullText(item);
			if (!fullText) return "";
			let bib = this.findBibliographySection(fullText);
			if (!bib) return "";

			let refs = this.resolveNumericRefs(bib, markers.numbers)
				.concat(this.resolveAuthorYearRefs(bib, markers.authorYears));
			return refs.slice(0, max).join("\n");
		}
		catch (e) {
			log("getReferences: " + e);
			return "";
		}
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
	buildVars({ text, ctx, comment }) {
		return {
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
	},

	buildPrompt({ text, ctx, color, comment }) {
		let tpl = this.getPromptForColor(color);
		let vars = this.buildVars({ text, ctx, comment });

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

	async generateComment({ text, ctx, color, comment }) {
		let prompt = this.buildPrompt({ text, ctx, color, comment });
		return this.provider() === "cli"
			? this.callCLI(prompt)
			: this.callOpenAI(prompt);
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
	async buildComment({ text, ctx, color, comment }) {
		let entry = this.getColorEntry(color);
		if (!entry) return null;

		let ai = "";
		if (this.entryNeedsAI(entry)) {
			if (!entry.prompt.trim()) return null;   // rien à demander au modèle
			ai = await this.generateComment({ text, ctx, color, comment });
		}
		if (!entry.template.trim()) return ai;

		let vars = this.buildVars({ text, ctx, comment });
		vars.ai = ai;
		return this.renderTemplate(entry.template, vars);
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
	async callOpenAI({ system, user }) {
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

		let resp = await this.httpJSON(cfg.endpoint, headers,
			{ model: cfg.model, temperature: temp, messages, stream: false });

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
			let detail = "";
			try { detail = e.xmlhttp ? e.xmlhttp.responseText : ""; } catch (e2) {}
			throw new Error("API (HTTP " + status + ") " + detail.slice(0, 300));
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
	isEligible(ann, overwrite) {
		if (!ann || !ann.isAnnotation || !ann.isAnnotation()) return false;
		if (!this.targetTypes().includes(ann.annotationType)) return false;
		if (ann.library && ann.library.editable === false) return false;
		if (!(ann.annotationText || "").trim()) return false;
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
		let eligible = all.filter(a => this.isEligible(a, overwrite));

		// Les couleurs sans prompt sont ignorées : on les compte à part pour
		// pouvoir l'expliquer, sinon l'absence de résultat serait incompréhensible.
		let targets = [];
		let noPrompt = 0;
		for (let a of eligible) {
			if (this.getPromptForColor(a.annotationColor)) targets.push(a);
			else noPrompt++;
		}

		if (!targets.length) {
			let why;
			if (noPrompt) {
				why = noPrompt + " highlight" + (noPrompt > 1 ? "s" : "")
					+ " skipped — their color has no prompt yet (Preferences → Annota).";
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
				ctx.references = await this.getReferences(ann, annText);
				// Le menu contextuel traite toutes les couleurs ayant un prompt,
				// « auto » ou « manuel ». Le commentaire existant (paraphrase
				// manuelle) est transmis via {{comment}}.
				let comment = await this.buildComment({
					text: annText,
					ctx,
					color: ann.annotationColor,
					comment: (ann.annotationComment || "").trim()
				});
				if (comment === null) { failed++; continue; }
				let fresh = await Zotero.Items.getAsync(ann.id);
				if (fresh) {
					fresh.annotationComment = comment;
					await fresh.saveTx();
					ok++;
				}
			}
			catch (e) {
				failed++;
				log("runBatch item " + ann.id + " : " + e);
			}
			bar.setProgress(Math.round(((i + 1) / targets.length) * 100));
			bar.setText("Generating " + (i + 1) + "/" + targets.length + "…");
		}

		bar.setProgress(100);
		let summary = ok + " comment" + (ok > 1 ? "s" : "") + " generated";
		if (failed) summary += ", " + failed + " failed (see debug output)";
		if (noPrompt) summary += ", " + noPrompt + " skipped (color has no prompt)";
		bar.setText(summary);
		pw.startCloseTimer(failed ? 8000 : 4000);
		log("runBatch terminé : " + ok + " ok, " + failed + " échecs, "
			+ noPrompt + " sans prompt");
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
		Annota.removeFromAllWindows();
	}
	try { delete Zotero.Annota; } catch (e) {}
	Annota = undefined;
}

function uninstall() {}
