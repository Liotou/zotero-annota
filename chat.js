/* eslint-disable no-undef */
// Annota — discussion avec le document ouvert ou avec la bibliothèque.
//
// Chargé par bootstrap.js dans sa propre portée globale : Annota, getPref, log
// et toast y sont visibles. Le panneau est une section du volet de l'item
// (API officielle Zotero.ItemPaneManager) : il apparaît à droite dans la
// bibliothèque comme dans le lecteur, sans toucher au code de Zotero.
//
// Aucun fournisseur nouveau : la discussion emploie ceux déjà réglés pour les
// annotations (API, Ollama, Claude CLI, Apple). Elle peut en choisir un autre,
// et un autre modèle, sans rien changer aux annotations.
//
// Deux portées :
//   document    texte intégral page par page, annotations, notes et notice de
//               l'item ; le modèle cite les pages [p. 12], cliquables.
//   bibliothèque recherche Zotero sur les mots de la question ; le modèle cite
//               les items [1], [2], cliquables.

var AnnotaChat = {
	HTML_NS: "http://www.w3.org/1999/xhtml",
	PLUGIN_ID: "annota@equiriconi",

	paneID: null,
	_conversations: new Map(),   // clé (id de l'item principal) → conversation
	_instances: new Map(),       // body de la section → panneau affiché
	_pendingQuotes: new Map(),   // clé → citations en attente d'un panneau
	_pageCache: new Map(),       // id de pièce jointe → { pages, paged, source }

	// Au-delà, l'extraction page par page coûte plus qu'elle ne rapporte.
	MAX_PAGES: 600,

	PROVIDER_LABELS: {
		openai: "Mistral / API",
		ollama: "Ollama (local)",
		cli: "Claude Code CLI",
		apple: "Apple Intelligence"
	},

	// Contexte envoyé par défaut, en caractères, selon le fournisseur. Un
	// modèle local a une fenêtre étroite : Ollama tronque en silence au-delà
	// de son num_ctx (4096 jetons par défaut), Apple ne dépasse pas 4096
	// jetons en tout. Les modèles distants et Claude encaissent un article
	// entier.
	AUTO_BUDGET: { openai: 100000, ollama: 12000, cli: 200000, apple: 6000 },

	// Mots vides, pour ne chercher que ce qui porte le sens de la question.
	STOPWORDS: new Set((
		"the and for are but not you all any can had her was one our out has have "
		+ "what when where which who whom why how this that these those with from "
		+ "into about than then them they their there here his its also does did "
		+ "doing done been being were will would should could may might must "
		+ "shall other some such only own same very just more most much many "
		+ "each few both between through during before after above below over "
		+ "under again further once paper article document text author authors "
		+ "study summarize summary explain tell give show list main please "
		+ "les des une est dans pour par sur avec que qui quoi quel quelle quels "
		+ "quelles sont ont aux ces ses son sa leur leurs mais donc car comme "
		+ "plus moins tout tous toute toutes elle elles ils nous vous lui eux "
		+ "cette cet celle celui ceux celles dont peut faire fait entre sans "
		+ "sous chez vers aussi bien tres être etre avoir texte auteur auteurs "
		+ "résume resume résumé expliquer explique donne liste quelles quels "
		+ "comment pourquoi quand est-ce selon article document"
	).split(/\s+/)),

	// ---- Fournisseur ----

	// Fournisseur de la discussion : le sien s'il est réglé, sinon celui des
	// annotations.
	provider() {
		let p = String(getPref("chatProvider", "") || "").trim();
		return Annota.PROVIDERS.includes(p) ? p : Annota.provider();
	},

	// Modèle propre à la discussion ; "" = celui des annotations.
	chatModel(p) {
		let key = { openai: "chatModel", ollama: "chatOllamaModel", cli: "chatCliModel" }[p];
		return key ? String(getPref(key, "") || "").trim() : "";
	},

	modelLabel(p) {
		if (p === "apple") return "on-device";
		let m = this.chatModel(p);
		if (m) return m;
		if (p === "cli") return String(getPref("cliModel", "") || "").trim() || "default model";
		return Annota.chatConfig(p).model;
	},

	budget(p) {
		let n = parseInt(getPref("chatMaxChars", 0), 10);
		if (n > 0) return Math.max(2000, n);
		return this.AUTO_BUDGET[p] || 40000;
	},

	// ---- Enregistrement de la section ----

	register() {
		let mgr = Zotero.ItemPaneManager;
		if (!mgr || typeof mgr.registerSection !== "function") {
			log("discussion : ItemPaneManager indisponible, panneau non enregistré");
			return;
		}
		let icon = Annota.rootURI + "chat.svg";
		let id = mgr.registerSection({
			paneID: "annota-chat",
			pluginID: this.PLUGIN_ID,
			header: { l10nID: "annota-chat-header", icon },
			sidenav: { l10nID: "annota-chat-sidenav", icon },
			onInit: ({ body }) => {
				try { this.mount(body); }
				catch (e) { log("discussion onInit: " + e); }
			},
			onDestroy: ({ body }) => this.unmount(body),
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(this.isSupported(item));
				return true;
			},
			onRender: ({ body, item }) => {
				try { this.show(body, item); }
				catch (e) { log("discussion onRender: " + e); }
			},
			onAsyncRender: async ({ body, item }) => {
				try { await this.describeSource(body, item); }
				catch (e) { log("discussion onAsyncRender: " + e); }
			}
		});
		this.paneID = id || null;
		log("Discussion enregistrée (" + this.paneID + ")");
	},

	unregister() {
		for (let conv of this._conversations.values()) {
			if (conv.cancel) conv.cancel.cancel();
		}
		try {
			if (this.paneID && Zotero.ItemPaneManager) {
				Zotero.ItemPaneManager.unregisterSection(this.paneID);
			}
		}
		catch (e) { log("discussion unregister: " + e); }
		for (let inst of this._instances.values()) {
			try {
				let st = inst.doc.getElementById("annota-chat-style");
				if (st) st.remove();
			}
			catch (e) {}
		}
		this.paneID = null;
		this._instances.clear();
		this._conversations.clear();
		this._pendingQuotes.clear();
		this._pageCache.clear();
	},

	isSupported(item) {
		return !!item && typeof item.isRegularItem === "function";
	},

	// ---- Items ----

	topItem(item) {
		let it = item;
		for (let i = 0; i < 3 && it && it.parentItem; i++) it = it.parentItem;
		return it || null;
	},

	// Une conversation par référence : le PDF lu dans le lecteur et sa notice
	// dans la bibliothèque partagent la même.
	keyFor(item) {
		let top = this.topItem(item);
		return top ? String(top.id) : null;
	},

	conversation(item) {
		let key = this.keyFor(item);
		if (!key) return null;
		let conv = this._conversations.get(key);
		if (!conv) {
			conv = { key, itemID: item.id, messages: [], scope: "document",
				busy: false, cancel: null, error: null, status: "" };
			this._conversations.set(key, conv);
		}
		return conv;
	},

	convItem(conv) {
		return conv ? Zotero.Items.get(conv.itemID) : null;
	},

	// PDF lu dans l'onglet courant, s'il appartient à cette référence : c'est
	// celui dont on parle, même si la référence a plusieurs pièces jointes.
	readerAttachmentFor(top) {
		try {
			let win = Zotero.getMainWindow();
			let tabID = win && win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
			if (!tabID) return null;
			let reader = typeof Zotero.Reader.getByTabID === "function"
				? Zotero.Reader.getByTabID(tabID)
				: (Zotero.Reader._readers || []).find(r => r.tabID === tabID);
			if (!reader) return null;
			let att = Zotero.Items.get(reader.itemID);
			if (att && (att.id === top.id || att.parentItemID === top.id)) return att;
		}
		catch (e) { log("readerAttachmentFor: " + e); }
		return null;
	},

	async resolveDocument(item) {
		let top = this.topItem(item);
		let att = null;
		try {
			if (item.isAnnotation && item.isAnnotation()) att = item.parentItem;
			else if (item.isAttachment && item.isAttachment()) att = item;
			else if (top && top.isRegularItem && top.isRegularItem()) {
				att = this.readerAttachmentFor(top) || await top.getBestAttachment();
			}
		}
		catch (e) { log("resolveDocument: " + e); }
		if (att && !(att.isFileAttachment && att.isFileAttachment())) att = null;
		return { top, att: att || null };
	},

	// ---- Texte du document ----

	cleanText(s) {
		return String(s || "")
			.replace(/­/g, "")
			.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
			.replace(/[ \t ]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	},

	// Texte sans pages : découpé en blocs, pour n'envoyer que les plus
	// pertinents quand il dépasse le budget.
	chunk(text, size = 3000) {
		let paras = this.cleanText(text).split(/\n{2,}/);
		let out = [], cur = "";
		for (let p of paras) {
			if (cur && cur.length + p.length > size) {
				out.push(cur);
				cur = "";
			}
			// Un paragraphe démesuré est coupé net.
			while (p.length > size * 1.5) {
				out.push(p.slice(0, size));
				p = p.slice(size);
			}
			cur += (cur ? "\n\n" : "") + p;
		}
		if (cur) out.push(cur);
		return out.map((t, i) => ({ index: i, label: null, text: t }));
	},

	// Texte page par page. Ordre de préférence :
	//   1. PDF ouvert : pdf.js donne chaque page ET son numéro imprimé, ce qui
	//      permet de citer « p. 215 » comme la revue, et d'y naviguer ;
	//   2. PDF fermé : extraction de Zotero (pages physiques, si séparées) ;
	//   3. EPUB, page web : texte indexé, sans pages.
	async documentPages(att) {
		if (!att) return { pages: [], paged: false };
		let reader = Annota.findReaderFor(att.id);
		let pdfDoc = reader ? Annota.getPDFDocument(reader) : null;
		let cached = this._pageCache.get(att.id);
		// Un texte lu sans le lecteur est relu dès que le PDF est ouvert : on y
		// gagne les numéros de page imprimés.
		if (cached && (cached.source === "reader" || !pdfDoc)) return cached;

		let res = null;
		if (pdfDoc) res = await this.pagesFromPDFJS(pdfDoc);
		if (!res && att.isPDFAttachment && att.isPDFAttachment()) {
			res = await this.pagesFromWorker(att);
		}
		if (!res) res = await this.pagesFromIndex(att);
		if (!res) return { pages: [], paged: false };

		if (this._pageCache.size > 4) {
			this._pageCache.delete(this._pageCache.keys().next().value);
		}
		this._pageCache.set(att.id, res);
		return res;
	},

	async pagesFromPDFJS(pdfDoc) {
		try {
			let n = Math.min(pdfDoc.numPages || 0, this.MAX_PAGES);
			let labels = null;
			try { labels = await pdfDoc.getPageLabels(); }
			catch (e) { /* pas de numérotation imprimée */ }
			let pages = [];
			for (let i = 0; i < n; i++) {
				let page = await pdfDoc.getPage(i + 1);
				let content = await page.getTextContent();
				let items = (content && content.items) || [];
				let out = "";
				for (let it of items) {
					let str = it && it.str;
					if (typeof str !== "string") continue;
					out += str + (it.hasEOL ? "\n" : " ");
				}
				let label = (labels && labels[i] && String(labels[i]).trim()) || String(i + 1);
				pages.push({ index: i, label, text: this.cleanText(out) });
			}
			if (!pages.some(p => p.text)) return null;
			return { pages, paged: true, source: "reader" };
		}
		catch (e) {
			log("pagesFromPDFJS: " + e);
			return null;
		}
	},

	async pagesFromWorker(att) {
		try {
			let res = await Zotero.PDFWorker.getFullText(att.id, null);
			let text = (res && res.text) ? String(res.text) : "";
			if (!text.trim()) return null;
			if (text.includes("\f")) {
				let pages = text.split("\f").map((t, i) => ({
					index: i, label: String(i + 1), text: this.cleanText(t)
				}));
				return { pages, paged: true, source: "worker" };
			}
			return { pages: this.chunk(text), paged: false, source: "worker" };
		}
		catch (e) {
			log("pagesFromWorker: " + e);
			return null;
		}
	},

	async pagesFromIndex(att) {
		try {
			let text = await att.attachmentText;
			if (!text || !String(text).trim()) return null;
			return { pages: this.chunk(String(text)), paged: false, source: "index" };
		}
		catch (e) {
			log("pagesFromIndex: " + e);
			return null;
		}
	},

	// ---- Pertinence ----

	fold(s) {
		return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	},

	// Mots porteurs de sens, en minuscules, accents conservés (la recherche
	// de Zotero n'ignore pas les accents ; le score, lui, les ignore).
	terms(text) {
		let words = String(text || "").toLowerCase()
			.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
		let out = [];
		for (let w of words) {
			w = w.replace(/^\p{L}['’]/u, "").replace(/['’-]+$/g, "");
			if (w.length < 3 || /^\d{1,3}$/.test(w)) continue;
			if (this.STOPWORDS.has(w) || this.STOPWORDS.has(this.fold(w))) continue;
			if (!out.includes(w)) out.push(w);
		}
		return out.slice(0, 12);
	},

	count(hay, needle) {
		if (!needle) return 0;
		let n = 0, i = 0;
		while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
		return n;
	},

	// Pages envoyées quand le document dépasse le budget : la première (titre,
	// résumé, introduction situent le propos), puis les plus proches de la
	// question. Sans mot porteur (« résume »), on garde le début, dans l'ordre.
	selectPages(pages, terms, budget) {
		let cost = p => p.text.length + 20;
		let total = pages.reduce((s, p) => s + cost(p), 0);
		if (total <= budget) return { chosen: pages, omitted: 0 };

		let folded = terms.map(t => this.fold(t));
		let scored = pages.map((p, pos) => {
			let ft = this.fold(p.text), s = 0;
			for (let t of folded) {
				let c = this.count(ft, t);
				if (c) s += 1 + Math.log(c);
			}
			return { pos, s };
		});

		let keep = new Set(), used = 0, cut = new Map();
		if (pages.length && cost(pages[0]) <= budget / 4) {
			keep.add(0);
			used += cost(pages[0]);
		}
		scored.sort((a, b) => b.s - a.s || a.pos - b.pos);
		for (let { pos, s } of scored) {
			if (keep.has(pos)) continue;
			let c = cost(pages[pos]);
			if (used + c > budget) {
				// Page pertinente plus longue que la place restante : son début
				// vaut mieux que rien.
				let room = budget - used - 20;
				if (s > 0 && room > 1500) {
					cut.set(pos, pages[pos].text.slice(0, room) + "…");
					keep.add(pos);
					used = budget;
				}
				continue;
			}
			keep.add(pos);
			used += c;
		}
		let chosen = pages.filter((p, pos) => keep.has(pos))
			.map(p => cut.has(pages.indexOf(p)) ? Object.assign({}, p, { text: cut.get(pages.indexOf(p)) }) : p);
		// Une seule page plus grande que le budget : tronquée plutôt que rien.
		if (!chosen.length && pages.length) {
			chosen = [Object.assign({}, pages[0], { text: pages[0].text.slice(0, budget - 100) })];
		}
		return { chosen, omitted: pages.length - chosen.length };
	},

	// ---- Contexte ----

	htmlToText(html) {
		return String(html || "")
			.replace(/<(br|\/p|\/div|\/h\d|\/li|\/blockquote)\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
			.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)))
			.replace(/&amp;/g, "&")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	},

	describeItem(item, abstractMax = 1500) {
		if (!item) return "";
		try {
			if (item.isNote && item.isNote()) {
				return "Note: " + Annota.truncate(this.htmlToText(item.getNote()), abstractMax);
			}
			if (!(item.isRegularItem && item.isRegularItem())) {
				return "Title: " + (item.getDisplayTitle ? item.getDisplayTitle() : "");
			}
			let f = k => { try { return String(item.getField(k) || ""); } catch (e) { return ""; } };
			let lines = [];
			let title = f("title");
			if (title) lines.push("Title: " + title);
			let creators = (typeof item.getCreators === "function") ? item.getCreators() : [];
			let names = creators
				.map(c => c.lastName ? c.lastName + (c.firstName ? ", " + c.firstName : "") : (c.name || ""))
				.filter(Boolean);
			if (names.length) lines.push("Authors: " + names.join("; "));
			let year = (f("date").match(/\d{4}/) || [])[0];
			if (year) lines.push("Year: " + year);
			let pub = f("publicationTitle") || f("bookTitle") || f("proceedingsTitle")
				|| f("publisher");
			if (pub) lines.push("Published in: " + pub);
			try { lines.push("Type: " + Zotero.ItemTypes.getName(item.itemTypeID)); }
			catch (e) {}
			let doi = f("DOI");
			if (doi) lines.push("DOI: " + doi);
			let abs = Annota.truncate(f("abstractNote"), abstractMax);
			if (abs) lines.push("Abstract: " + abs);
			return lines.join("\n");
		}
		catch (e) {
			log("describeItem: " + e);
			return "";
		}
	},

	notesText(top, max) {
		try {
			let out = [];
			for (let id of top.getNotes()) {
				let n = Zotero.Items.get(id);
				let t = n ? this.htmlToText(n.getNote()) : "";
				if (t) out.push("- " + t.replace(/\n+/g, " "));
			}
			return Annota.truncate(out.join("\n"), max);
		}
		catch (e) {
			log("notesText: " + e);
			return "";
		}
	},

	annotationLine(a) {
		let text = String(a.annotationText || "").replace(/\s+/g, " ").trim();
		let comment = this.htmlToText(a.annotationComment || "").replace(/\s+/g, " ");
		if (!text && !comment) return "";
		let label = Annota.labelForColor(a.annotationColor);
		return "- " + (a.annotationPageLabel ? "p. " + a.annotationPageLabel + " " : "")
			+ (label ? "[" + label + "] " : "")
			+ (text ? "“" + text + "”" : "")
			+ (comment ? (text ? " — comment: " : "comment: ") + comment : "");
	},

	annotationsText(att, max) {
		try {
			let anns = (typeof att.getAnnotations === "function") ? att.getAnnotations() : [];
			anns = anns.slice().sort((a, b) =>
				String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)));
			let lines = anns.map(a => this.annotationLine(a)).filter(Boolean);
			return Annota.truncate(lines.join("\n"), max);
		}
		catch (e) {
			log("annotationsText: " + e);
			return "";
		}
	},

	async buildDocumentContext(item, terms, budget) {
		let { top, att } = await this.resolveDocument(item);
		let parts = [];
		let meta = this.describeItem(top || item, 3000);
		if (meta) parts.push("REFERENCE\n" + meta);
		let room = budget - meta.length;

		if (getPref("chatIncludeNotes", true) && top && top.isRegularItem && top.isRegularItem()) {
			let notes = this.notesText(top, Math.floor(budget * 0.15));
			if (notes) {
				parts.push("THE RESEARCHER'S NOTES ON THIS REFERENCE\n" + notes);
				room -= notes.length;
			}
		}
		if (getPref("chatIncludeAnnotations", true) && att) {
			let anns = this.annotationsText(att, Math.floor(budget * 0.25));
			if (anns) {
				parts.push("THE RESEARCHER'S ANNOTATIONS (highlights and comments)\n" + anns);
				room -= anns.length;
			}
		}

		let paged = false, pageMap = null, omitted = 0, sent = 0;
		let doc = att ? await this.documentPages(att) : { pages: [], paged: false };
		if (doc.pages.length) {
			paged = doc.paged;
			let sel = this.selectPages(doc.pages, terms, Math.max(room, 1500));
			omitted = sel.omitted;
			sent = sel.chosen.length;
			let body = [], prev = -1;
			for (let p of sel.chosen) {
				if (p.index !== prev + 1) body.push("[…]");
				body.push(paged ? "[[p. " + p.label + "]]\n" + p.text : p.text);
				prev = p.index;
			}
			if (prev < doc.pages.length - 1) body.push("[…]");
			let unit = paged ? "pages" : "passages";
			parts.push("FULL TEXT"
				+ (omitted ? " (excerpts: " + omitted + " " + unit + " least related to the"
					+ " question were left out — say so if they may matter)" : "")
				+ "\n" + body.join("\n\n"));

			// Table numéro imprimé → page physique, pour naviguer depuis une
			// citation. Inutile quand les deux coïncident.
			if (paged && doc.pages.some(p => p.label !== String(p.index + 1))) {
				pageMap = {};
				for (let p of doc.pages) {
					if (!(p.label in pageMap)) pageMap[p.label] = p.index;
				}
			}
		}
		else {
			parts.push("FULL TEXT\n(not available: no PDF or EPUB attached, or no"
				+ " extractable text — work from the reference, notes and annotations)");
		}
		return {
			text: parts.join("\n\n"), paged, pageMap, att, top,
			stats: { pages: doc.pages.length, sent, omitted, paged }
		};
	},

	async searchLibrary(libraryID, terms) {
		let scores = new Map();
		for (let t of terms.slice(0, 8)) {
			let ids = [];
			try {
				let s = new Zotero.Search();
				s.libraryID = libraryID;
				s.addCondition("quicksearch-everything", "contains", t);
				ids = await s.search();
			}
			catch (e) {
				log("searchLibrary « " + t + " » : " + e);
				continue;
			}
			let ft = this.fold(t), seen = new Set();
			for (let id of ids) {
				let it = Zotero.Items.get(id);
				if (!it || it.deleted) continue;
				let top = this.topItem(it);
				if (!top || top.deleted || seen.has(top.id)) continue;
				seen.add(top.id);
				let rec = scores.get(top.id) || { item: top, score: 0 };
				rec.score += 1;
				let title = this.fold(top.getDisplayTitle ? top.getDisplayTitle() : "");
				if (title.includes(ft)) rec.score += 1;
				scores.set(top.id, rec);
			}
		}
		return Array.from(scores.values()).sort((a, b) => b.score - a.score
			|| String(b.item.dateModified).localeCompare(String(a.item.dateModified)));
	},

	matchingAnnotations(top, folded, max) {
		try {
			if (!(top.isRegularItem && top.isRegularItem())) return "";
			let out = [];
			for (let attID of top.getAttachments()) {
				let att = Zotero.Items.get(attID);
				if (!att || typeof att.getAnnotations !== "function") continue;
				for (let a of att.getAnnotations()) {
					let hay = this.fold((a.annotationText || "") + " " + (a.annotationComment || ""));
					if (!folded.some(t => hay.includes(t))) continue;
					let line = this.annotationLine(a);
					if (line) out.push(line);
					if (out.length >= max) return out.join("\n");
				}
			}
			return out.join("\n");
		}
		catch (e) {
			log("matchingAnnotations: " + e);
			return "";
		}
	},

	async buildLibraryContext(item, terms, budget) {
		let libraryID = (item && item.libraryID) || Zotero.Libraries.userLibraryID;
		let head = "LIBRARY SEARCH\nSearched the researcher's Zotero library for: "
			+ (terms.length ? terms.join(", ") : "(no usable keyword)");
		if (!terms.length) {
			return { text: head + "\nNothing searched: ask the researcher for keywords.", sources: [] };
		}
		let max = parseInt(getPref("chatLibraryItems", 8), 10);
		if (isNaN(max) || max < 1) max = 8;
		let hits = (await this.searchLibrary(libraryID, terms)).slice(0, Math.min(max, 30));
		if (!hits.length) {
			return { text: head + "\nNo matching item.", sources: [] };
		}
		let per = Math.floor((budget - head.length) / hits.length);
		let folded = terms.map(t => this.fold(t));
		let blocks = [], sources = [];
		hits.forEach((h, i) => {
			let n = i + 1;
			let block = "[" + n + "]\n" + this.describeItem(h.item, Math.max(300, per - 700));
			let anns = this.matchingAnnotations(h.item, folded, 3);
			if (anns) block += "\nThe researcher's annotations:\n" + anns;
			blocks.push(Annota.truncate(block, per));
			sources.push({ n, id: h.item.id });
		});
		return { text: head + "\n\n" + blocks.join("\n\n"), sources };
	},

	systemPrompt(scope, paged) {
		let lines = [
			"You are a research assistant inside Zotero, the reference manager of a researcher.",
			"Work from the material provided below. When it does not contain the answer,"
				+ " say so plainly; you may then add general knowledge, clearly flagged as such.",
			"Never invent quotations, page numbers, authors or references."
		];
		if (scope === "library") {
			lines.push("The material lists items from the researcher's library, numbered"
				+ " [1], [2]… Cite them right after each claim they support, with their"
				+ " number in square brackets: [2] or [1, 3]. Only cite numbers listed.");
		}
		else if (paged) {
			lines.push("The full text is split by page markers such as [[p. 12]]. Cite the"
				+ " page of every claim you draw from it, in square brackets: [p. 12] or"
				+ " [p. 12–13]. Only use page numbers that appear in a marker.");
		}
		else {
			lines.push("The full text has no page markers: do not give page numbers;"
				+ " quote a few words instead when precision matters.");
		}
		lines.push("The researcher's own annotations and notes, when present, show what"
			+ " they found important: use them, and keep them distinct from the author's text.");
		lines.push("Answer in the language of the researcher's last message unless asked"
			+ " otherwise. Be precise and concise; use Markdown (short paragraphs, lists,"
			+ " bold) when it helps.");
		let extra = String(getPref("chatInstructions", "") || "").trim();
		if (extra) lines.push("", "Additional instructions from the researcher:", extra);
		return lines.join("\n");
	},

	// Tours précédents envoyés au modèle : les plus récents, dans une part
	// du budget. Une question restée sans réponse (échec, arrêt) est écartée :
	// deux messages « user » consécutifs embarrassent certaines API.
	historyFor(conv, maxChars) {
		let msgs = conv.messages.slice(0, -1);
		let pairs = [];
		for (let i = 0; i < msgs.length; i++) {
			if (msgs[i].role === "user" && msgs[i + 1] && msgs[i + 1].role === "assistant") {
				pairs.push([msgs[i], msgs[i + 1]]);
				i++;
			}
		}
		let out = [], used = 0;
		for (let k = pairs.length - 1; k >= 0 && out.length < 12; k--) {
			let [u, a] = pairs[k];
			let c = u.content.length + a.content.length;
			if (used + c > maxChars) break;
			out.unshift({ role: "assistant", content: a.content });
			out.unshift({ role: "user", content: u.content });
			used += c;
		}
		return out;
	},

	// ---- Envoi ----

	async submit(inst, text) {
		let conv = this.conversationOf(inst);
		text = String(text || "").trim();
		if (!conv || !text || conv.busy) return;
		let p = this.provider();
		let notReady = Annota.providerReadyError(p);
		if (notReady) {
			conv.error = { message: notReady + " — or pick another provider above." };
			this.refresh(conv);
			return;
		}
		conv.messages.push({ role: "user", content: text });
		inst.input.value = "";
		await this.answer(conv);
	},

	async answer(conv) {
		let p = this.provider();
		let item = this.convItem(conv);
		let question = conv.messages[conv.messages.length - 1].content;
		conv.busy = true;
		conv.error = null;
		conv.cancel = Annota.makeCancelToken();
		conv.status = conv.scope === "library" ? "Searching your library…" : "Reading the document…";
		this.refresh(conv);

		try {
			let budget = this.budget(p);
			// Les mots de la question précédente comptent pour une relance
			// (« et la seconde ? »), qui n'en a guère.
			let users = conv.messages.filter(m => m.role === "user");
			let terms = this.terms(question);
			if (terms.length < 3 && users.length > 1) {
				for (let t of this.terms(users[users.length - 2].content)) {
					if (!terms.includes(t)) terms.push(t);
				}
			}

			let ctx, extra = { scope: conv.scope };
			if (conv.scope === "library") {
				ctx = await this.buildLibraryContext(item, terms, Math.floor(budget * 0.8));
				extra.sources = ctx.sources;
				extra.note = ctx.sources.length
					? ctx.sources.length + " items found" : "no matching item";
			}
			else {
				ctx = await this.buildDocumentContext(item, terms, Math.floor(budget * 0.8));
				extra.attachmentID = ctx.att ? ctx.att.id : null;
				extra.pageMap = ctx.pageMap;
				let st = ctx.stats;
				if (st.pages) {
					extra.note = st.omitted
						? st.sent + "/" + st.pages + (st.paged ? " pages" : " passages") + " sent"
						: "full text sent";
				}
				else extra.note = "no full text";
			}
			if (conv.cancel.cancelled) {
				let err = new Error("Stopped");
				err.cancelled = true;
				throw err;
			}

			conv.status = "Waiting for " + this.PROVIDER_LABELS[p] + "…";
			this.refresh(conv);
			let t0 = Date.now();
			let reply = await Annota.complete({
				system: this.systemPrompt(conv.scope, !!ctx.paged),
				context: ctx.text,
				history: this.historyFor(conv, Math.floor(budget * 0.2)),
				user: question
			}, {
				provider: p,
				model: this.chatModel(p) || undefined,
				raw: true,
				timeout: p === "cli" ? 300000 : 240000,
				cancel: conv.cancel
			});
			conv.messages.push(Object.assign({
				role: "assistant",
				content: String(reply || "").trim(),
				provider: p,
				model: this.modelLabel(p),
				seconds: Math.round((Date.now() - t0) / 100) / 10
			}, extra));
		}
		catch (e) {
			conv.error = (e && e.cancelled) || (conv.cancel && conv.cancel.cancelled)
				? { message: "Stopped.", stopped: true }
				: { message: String((e && e.message) || e) };
			log("discussion : " + conv.error.message);
		}
		finally {
			conv.busy = false;
			conv.cancel = null;
			conv.status = "";
			this.refresh(conv);
		}
	},

	stop(conv) {
		if (conv && conv.cancel) conv.cancel.cancel();
	},

	// ---- Panneau ----

	el(doc, tag, cls, text) {
		let e = doc.createElementNS(this.HTML_NS, tag);
		if (cls) e.setAttribute("class", cls);
		if (text != null) e.textContent = text;
		return e;
	},

	button(doc, label, cls, onClick, title) {
		let b = this.el(doc, "button", cls || "annota-chat-btn", label);
		b.setAttribute("type", "button");
		if (title) b.setAttribute("title", title);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick(e);
		});
		return b;
	},

	mount(body) {
		let existing = this._instances.get(body);
		if (existing) return existing;
		let doc = body.ownerDocument;
		this.ensureStyles(doc);

		let root = this.el(doc, "div", "annota-chat");

		let bar = this.el(doc, "div", "annota-chat-bar");
		let scopeSel = this.el(doc, "select", "annota-chat-select");
		scopeSel.setAttribute("title", "What the model reads");
		for (let [v, l] of [["document", "📄 This document"], ["library", "📚 My library"]]) {
			let o = this.el(doc, "option", null, l);
			o.setAttribute("value", v);
			scopeSel.appendChild(o);
		}
		let provSel = this.el(doc, "select", "annota-chat-select");
		provSel.setAttribute("title", "AI provider for the chat");
		bar.appendChild(scopeSel);
		bar.appendChild(provSel);

		let sub = this.el(doc, "div", "annota-chat-sub");
		let subText = this.el(doc, "span", "annota-chat-sub-text");
		sub.appendChild(subText);

		let logBox = this.el(doc, "div", "annota-chat-log");
		let status = this.el(doc, "div", "annota-chat-status");

		let form = this.el(doc, "div", "annota-chat-form");
		let input = this.el(doc, "textarea", "annota-chat-input");
		input.setAttribute("rows", "3");
		let send = this.button(doc, "Send", "annota-chat-send", () => {
			let conv = this.conversationOf(inst);
			if (conv && conv.busy) this.stop(conv);
			else this.submit(inst, input.value);
		});
		form.appendChild(input);
		form.appendChild(send);

		let tools = this.el(doc, "div", "annota-chat-tools");

		root.appendChild(bar);
		root.appendChild(sub);
		root.appendChild(logBox);
		root.appendChild(status);
		root.appendChild(form);
		root.appendChild(tools);
		body.textContent = "";
		body.appendChild(root);

		let inst = { body, doc, root, scopeSel, provSel, subText, log: logBox, status,
			input, send, tools, key: null, item: null, docLabel: "" };

		tools.appendChild(this.button(doc, "New chat", "annota-chat-link", () => {
			let conv = this.conversationOf(inst);
			if (!conv || conv.busy) return;
			conv.messages = [];
			conv.error = null;
			this.refresh(conv);
			input.focus();
		}, "Start over — the current exchange is forgotten"));
		tools.appendChild(this.button(doc, "Save chat as note", "annota-chat-link", () => {
			let conv = this.conversationOf(inst);
			if (conv && conv.messages.length) {
				this.saveNote(conv, conv.messages).catch(e => log("saveNote: " + e));
			}
		}, "Save the whole exchange as a child note of this reference"));

		// Le lecteur et la fenêtre principale ont leurs raccourcis clavier : la
		// frappe s'arrête au panneau.
		for (let type of ["keydown", "keypress", "keyup"]) {
			root.addEventListener(type, e => e.stopPropagation());
		}
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				let conv = this.conversationOf(inst);
				if (conv && !conv.busy) this.submit(inst, input.value);
			}
		});
		scopeSel.addEventListener("change", () => {
			let conv = this.conversationOf(inst);
			if (conv) conv.scope = scopeSel.value === "library" ? "library" : "document";
			this.refresh(conv);
			this.updateSubtitle(inst);
		});
		provSel.addEventListener("change", () => {
			Zotero.Prefs.set("annota.chatProvider", provSel.value || "");
			for (let other of this._instances.values()) {
				this.fillProviders(other);
				this.updateSubtitle(other);
			}
		});

		this.fillProviders(inst);
		this._instances.set(body, inst);
		return inst;
	},

	unmount(body) {
		this._instances.delete(body);
	},

	conversationOf(inst) {
		return inst && inst.key ? this._conversations.get(inst.key) || null : null;
	},

	fillProviders(inst) {
		let sel = inst.provSel;
		let stored = String(getPref("chatProvider", "") || "").trim();
		if (!Annota.PROVIDERS.includes(stored)) stored = "";
		sel.textContent = "";
		let def = Annota.provider();
		let opts = [["", "Default — " + this.PROVIDER_LABELS[def]]]
			.concat(Annota.PROVIDERS.map(p => [p, this.PROVIDER_LABELS[p]]));
		for (let [v, l] of opts) {
			let o = this.el(inst.doc, "option", null, l);
			o.setAttribute("value", v);
			// Fournisseur non configuré : visible mais signalé, l'envoi dira pourquoi.
			if (v && Annota.providerReadyError(v)) o.textContent = l + " (not set up)";
			sel.appendChild(o);
		}
		sel.value = stored;
	},

	updateSubtitle(inst) {
		let conv = this.conversationOf(inst);
		let p = this.provider();
		let where = conv && conv.scope === "library" ? "📚 Library search" : (inst.docLabel || "📄 …");
		inst.subText.textContent = where + " · " + this.PROVIDER_LABELS[p] + " · " + this.modelLabel(p);
		inst.subText.setAttribute("title", inst.subText.textContent);
	},

	show(body, item) {
		let inst = this._instances.get(body) || this.mount(body);
		if (!item) return;
		inst.item = item;
		let key = this.keyFor(item);
		if (!key) return;
		if (inst.key !== key) {
			inst.key = key;
			inst.docLabel = "";
			this.conversation(item);
		}
		this.fillProviders(inst);
		this.renderInstance(inst);
		this.updateSubtitle(inst);
		this.takeQuotes(inst);
	},

	async describeSource(body, item) {
		let inst = this._instances.get(body);
		if (!inst || !item) return;
		let key = this.keyFor(item);
		let { att } = await this.resolveDocument(item);
		if (inst.key !== key) return;
		if (att) {
			let name = "";
			try { name = att.attachmentFilename || att.getDisplayTitle(); }
			catch (e) { name = "attachment"; }
			inst.docLabel = "📄 " + name;
		}
		else inst.docLabel = "📄 No attachment — reference, notes only";
		this.updateSubtitle(inst);
	},

	// Toutes les vues ouvertes sur cette conversation (bibliothèque et lecteur
	// peuvent montrer la même référence).
	refresh(conv) {
		if (!conv) return;
		for (let inst of this._instances.values()) {
			if (inst.key === conv.key) this.renderInstance(inst);
		}
	},

	renderInstance(inst) {
		let conv = this.conversationOf(inst);
		if (!conv) return;
		let doc = inst.doc;
		inst.scopeSel.value = conv.scope;
		inst.input.setAttribute("placeholder", conv.scope === "library"
			? "Ask your library… (Enter to send, Shift+Enter for a new line)"
			: "Ask about this document… (Enter to send, Shift+Enter for a new line)");
		inst.send.textContent = conv.busy ? "Stop" : "Send";
		inst.send.setAttribute("data-busy", conv.busy ? "true" : "false");
		inst.status.textContent = conv.busy ? "⏳ " + (conv.status || "Working…") : "";

		let box = inst.log;
		box.textContent = "";
		if (!conv.messages.length && !conv.busy && !conv.error) {
			box.appendChild(this.renderEmpty(inst, conv));
		}
		conv.messages.forEach((m, i) => box.appendChild(this.renderMessage(inst, conv, m, i)));
		if (conv.error) {
			let err = this.el(doc, "div", "annota-chat-msg annota-chat-error");
			err.appendChild(this.el(doc, "div", null, conv.error.message));
			let last = conv.messages[conv.messages.length - 1];
			if (last && last.role === "user" && !conv.busy) {
				let actions = this.el(doc, "div", "annota-chat-actions");
				actions.appendChild(this.button(doc, "Retry", "annota-chat-link", () => {
					this.answer(conv).catch(e => log("answer: " + e));
				}));
				err.appendChild(actions);
			}
			box.appendChild(err);
		}
		box.scrollTop = box.scrollHeight;
	},

	SUGGESTIONS: {
		document: [
			["Summarize", "Summarize this document: question, method, main findings."],
			["Main argument", "What is the main argument, and how is it supported?"],
			["Methods & data", "Which methods and data does it use?"],
			["Limitations", "What are its limitations, stated or not?"],
			["My annotations", "Summarize my annotations on this document."]
		],
		library: [
			["What do I have on…", "What does my library say about "],
			["Compare", "Compare how the items in my library address "]
		]
	},

	renderEmpty(inst, conv) {
		let doc = inst.doc;
		let wrap = this.el(doc, "div", "annota-chat-empty");
		wrap.appendChild(this.el(doc, "div", null, conv.scope === "library"
			? "Ask a question: Annota searches your library for matching references,"
				+ " notes and annotations, and the answer cites them."
			: "Ask anything about this document. Answers cite pages — click one to jump"
				+ " there. Select text in the PDF and use “💬 Ask Annota” to quote it."));
		let chips = this.el(doc, "div", "annota-chat-suggest");
		for (let [label, prompt] of this.SUGGESTIONS[conv.scope] || []) {
			chips.appendChild(this.button(doc, label, "annota-chat-chip", () => {
				// Une suggestion ouverte (« … about ») attend la fin de la phrase.
				if (/\s$/.test(prompt)) {
					inst.input.value = prompt;
					inst.input.focus();
				}
				else this.submit(inst, prompt);
			}));
		}
		wrap.appendChild(chips);
		return wrap;
	},

	renderMessage(inst, conv, m, i) {
		let doc = inst.doc;
		let wrap = this.el(doc, "div", "annota-chat-msg annota-chat-" + m.role);
		wrap.appendChild(this.renderMarkdown(doc, m.content, m.role === "assistant" ? m : null));
		if (m.role !== "assistant") return wrap;

		let actions = this.el(doc, "div", "annota-chat-actions");
		actions.appendChild(this.button(doc, "Copy", "annota-chat-link", () => {
			try { Zotero.Utilities.Internal.copyTextToClipboard(m.content); }
			catch (e) { log("copy: " + e); }
		}));
		actions.appendChild(this.button(doc, "Save as note", "annota-chat-link", () => {
			let q = conv.messages[i - 1];
			let pair = q && q.role === "user" ? [q, m] : [m];
			this.saveNote(conv, pair).catch(e => log("saveNote: " + e));
		}, "Save this answer, with its question, as a child note"));
		let meta = [this.PROVIDER_LABELS[m.provider] || m.provider, m.model,
			m.seconds != null ? m.seconds + " s" : "", m.note].filter(Boolean).join(" · ");
		actions.appendChild(this.el(doc, "span", "annota-chat-meta", meta));
		wrap.appendChild(actions);
		return wrap;
	},

	// ---- Markdown → DOM (jamais innerHTML : la réponse vient d'un modèle et
	// le panneau vit dans une fenêtre privilégiée) ----

	mdBlocks(text) {
		let lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
		let blocks = [], cur = null;
		let close = () => { if (cur) { blocks.push(cur); cur = null; } };
		const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
		for (let line of lines) {
			let m;
			if (cur && cur.type === "code") {
				if (/^\s*```/.test(line)) close();
				else cur.lines.push(line);
				continue;
			}
			if (/^\s*```/.test(line)) { close(); cur = { type: "code", lines: [] }; continue; }
			if (!line.trim()) { close(); continue; }
			if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/))) {
				close();
				blocks.push({ type: "h", text: m[1] });
				continue;
			}
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { close(); blocks.push({ type: "hr" }); continue; }
			if ((m = line.match(/^\s*>\s?(.*)$/))) {
				if (!cur || cur.type !== "quote") { close(); cur = { type: "quote", lines: [] }; }
				cur.lines.push(m[1]);
				continue;
			}
			if (/^\s*\|.*\|\s*$/.test(line)) {
				if (!cur || cur.type !== "table") { close(); cur = { type: "table", rows: [] }; }
				if (!SEP.test(line)) {
					cur.rows.push(line.trim().replace(/^\|/, "").replace(/\|$/, "")
						.split("|").map(c => c.trim()));
				}
				continue;
			}
			if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) {
				if (!cur || cur.type !== "ul") { close(); cur = { type: "ul", items: [] }; }
				cur.items.push(m[1]);
				continue;
			}
			if ((m = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/))) {
				if (!cur || cur.type !== "ol") {
					close();
					cur = { type: "ol", items: [], start: parseInt(m[1], 10) };
				}
				cur.items.push(m[2]);
				continue;
			}
			if (cur && (cur.type === "ul" || cur.type === "ol") && /^\s+\S/.test(line)) {
				cur.items[cur.items.length - 1] += "\n" + line.trim();
				continue;
			}
			if (cur && cur.type === "p") { cur.lines.push(line); continue; }
			close();
			cur = { type: "p", lines: [line] };
		}
		close();
		return blocks;
	},

	INLINE_SRC: "(`[^`\\n]+`)"
		+ "|(\\*\\*[^\\n]+?\\*\\*|__[^\\n]+?__)"
		+ "|(\\*[^*\\s](?:[^*\\n]*?[^*\\s])?\\*)"
		+ "|(\\[(?:pp?\\.|pages?)\\s*[^\\]\\n]{1,40}\\])"
		+ "|(\\[\\d{1,3}(?:\\s*[,;–-]\\s*\\d{1,3})*\\])",

	inlineTokens(text, depth = 0) {
		let re = new RegExp(this.INLINE_SRC, "gi");
		let out = [], last = 0, m;
		let inner = s => depth < 3 ? this.inlineTokens(s, depth + 1) : [{ t: "text", v: s }];
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
			if (m[1]) out.push({ t: "code", v: m[1].slice(1, -1) });
			else if (m[2]) out.push({ t: "b", c: inner(m[2].slice(2, -2)) });
			else if (m[3]) out.push({ t: "i", c: inner(m[3].slice(1, -1)) });
			else if (m[4]) out.push({ t: "page", v: m[4] });
			else if (m[5]) out.push({ t: "src", v: m[5] });
			last = re.lastIndex;
		}
		if (last < text.length) out.push({ t: "text", v: text.slice(last) });
		return out;
	},

	// « [p. 12–13, 15] » → préfixe, puis morceaux : séparateurs et numéros.
	// Le premier numéro d'un intervalle sert de cible.
	splitCitation(v, isPage) {
		let inner = v.slice(1, -1);
		let prefix = "";
		if (isPage) {
			let pm = inner.match(/^(pp?\.|pages?)\s*/i);
			prefix = pm ? pm[0] : "";
			inner = inner.slice(prefix.length);
		}
		let parts = inner.split(/(\s*[,;]\s*|\s+(?:and|et)\s+)/);
		return {
			prefix,
			parts: parts.map((s, k) => {
				if (k % 2) return { sep: s };
				let target = (s.match(isPage ? /^[\p{L}\p{N}]+/u : /^\d+/u) || [])[0] || "";
				return { text: s, target };
			})
		};
	},

	pageIndexFor(msg, label) {
		if (msg.pageMap && Object.prototype.hasOwnProperty.call(msg.pageMap, label)) {
			return msg.pageMap[label];
		}
		let n = parseInt(label, 10);
		return isNaN(n) ? null : n - 1;
	},

	openPage(msg, label) {
		let idx = this.pageIndexFor(msg, label);
		if (!msg.attachmentID || idx === null) return;
		Zotero.Reader.open(msg.attachmentID, { pageIndex: idx })
			.catch(e => log("openPage: " + e));
	},

	selectItem(id) {
		try {
			let win = Zotero.getMainWindow();
			if (win.Zotero_Tabs) win.Zotero_Tabs.select("zotero-pane");
			let r = win.ZoteroPane.selectItem(id);
			if (r && r.catch) r.catch(e => log("selectItem: " + e));
		}
		catch (e) { log("selectItem: " + e); }
	},

	citeLink(doc, text, title, onClick) {
		let a = this.el(doc, "span", "annota-chat-cite", text);
		a.setAttribute("role", "link");
		a.setAttribute("tabindex", "0");
		a.setAttribute("title", title);
		a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
		a.addEventListener("keydown", (e) => { if (e.key === "Enter") onClick(); });
		return a;
	},

	appendCitation(doc, parent, v, msg, isPage) {
		let sources = (msg && msg.sources) || [];
		let linkable = isPage ? !!(msg && msg.attachmentID) : sources.length > 0;
		if (!linkable) { parent.appendChild(doc.createTextNode(v)); return; }
		let { prefix, parts } = this.splitCitation(v, isPage);
		let span = this.el(doc, "span", "annota-chat-citegroup");
		span.appendChild(doc.createTextNode("[" + prefix));
		for (let part of parts) {
			if (part.sep !== undefined) { span.appendChild(doc.createTextNode(part.sep)); continue; }
			if (isPage && part.target && this.pageIndexFor(msg, part.target) !== null) {
				span.appendChild(this.citeLink(doc, part.text, "Open page " + part.target,
					() => this.openPage(msg, part.target)));
				continue;
			}
			let src = !isPage && sources.find(s => String(s.n) === part.target);
			if (src) {
				let it = Zotero.Items.get(src.id);
				let title = it ? (it.getDisplayTitle ? it.getDisplayTitle() : "") : "";
				span.appendChild(this.citeLink(doc, part.text, title || "Show in library",
					() => this.selectItem(src.id)));
				continue;
			}
			span.appendChild(doc.createTextNode(part.text));
		}
		span.appendChild(doc.createTextNode("]"));
		parent.appendChild(span);
	},

	appendInline(doc, parent, tokens, msg) {
		for (let tk of tokens) {
			if (tk.t === "text") {
				let lines = tk.v.split("\n");
				lines.forEach((l, k) => {
					if (k) parent.appendChild(this.el(doc, "br"));
					if (l) parent.appendChild(doc.createTextNode(l));
				});
			}
			else if (tk.t === "code") parent.appendChild(this.el(doc, "code", null, tk.v));
			else if (tk.t === "b" || tk.t === "i") {
				let e = this.el(doc, tk.t === "b" ? "strong" : "em");
				this.appendInline(doc, e, tk.c, msg);
				parent.appendChild(e);
			}
			else if (tk.t === "page") this.appendCitation(doc, parent, tk.v, msg, true);
			else if (tk.t === "src") this.appendCitation(doc, parent, tk.v, msg, false);
		}
	},

	renderMarkdown(doc, text, msg) {
		let root = this.el(doc, "div", "annota-chat-md");
		let inline = (parent, s) => this.appendInline(doc, parent, this.inlineTokens(s), msg);
		for (let b of this.mdBlocks(text)) {
			let e;
			if (b.type === "p") { e = this.el(doc, "p"); inline(e, b.lines.join("\n")); }
			else if (b.type === "h") { e = this.el(doc, "p", "annota-chat-h"); inline(e, b.text); }
			else if (b.type === "hr") e = this.el(doc, "hr");
			else if (b.type === "quote") { e = this.el(doc, "blockquote"); inline(e, b.lines.join("\n")); }
			else if (b.type === "code") e = this.el(doc, "pre", null, b.lines.join("\n"));
			else if (b.type === "ul" || b.type === "ol") {
				e = this.el(doc, b.type);
				if (b.type === "ol" && b.start > 1) e.setAttribute("start", String(b.start));
				for (let it of b.items) {
					let li = this.el(doc, "li");
					inline(li, it);
					e.appendChild(li);
				}
			}
			else if (b.type === "table") {
				e = this.el(doc, "table");
				b.rows.forEach((row, r) => {
					let tr = this.el(doc, "tr");
					for (let cell of row) {
						let td = this.el(doc, r === 0 ? "th" : "td");
						inline(td, cell);
						tr.appendChild(td);
					}
					e.appendChild(tr);
				});
			}
			if (e) root.appendChild(e);
		}
		return root;
	},

	// ---- Markdown → HTML de note (texte échappé, liens zotero://) ----

	esc(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	},

	libraryPath(libraryID) {
		try {
			let lib = Zotero.Libraries.get(libraryID);
			if (lib && lib.libraryType === "group") {
				return "groups/" + Zotero.Groups.getGroupIDFromLibraryID(libraryID);
			}
		}
		catch (e) {}
		return "library";
	},

	citationHTML(v, msg, isPage) {
		let sources = (msg && msg.sources) || [];
		let att = isPage && msg && msg.attachmentID ? Zotero.Items.get(msg.attachmentID) : null;
		if (isPage ? !att : !sources.length) return this.esc(v);
		let { prefix, parts } = this.splitCitation(v, isPage);
		let out = "[" + this.esc(prefix);
		for (let part of parts) {
			if (part.sep !== undefined) { out += this.esc(part.sep); continue; }
			let href = "";
			if (isPage) {
				let idx = part.target ? this.pageIndexFor(msg, part.target) : null;
				if (idx !== null) {
					href = "zotero://open-pdf/" + this.libraryPath(att.libraryID)
						+ "/items/" + att.key + "?page=" + (idx + 1);
				}
			}
			else {
				let src = sources.find(s => String(s.n) === part.target);
				let it = src && Zotero.Items.get(src.id);
				if (it) href = "zotero://select/" + this.libraryPath(it.libraryID) + "/items/" + it.key;
			}
			out += href
				? "<a href=\"" + this.esc(href) + "\">" + this.esc(part.text) + "</a>"
				: this.esc(part.text);
		}
		return out + "]";
	},

	inlineHTML(tokens, msg) {
		return tokens.map(tk => {
			if (tk.t === "text") return this.esc(tk.v).replace(/\n/g, "<br/>");
			if (tk.t === "code") return "<code>" + this.esc(tk.v) + "</code>";
			if (tk.t === "b") return "<strong>" + this.inlineHTML(tk.c, msg) + "</strong>";
			if (tk.t === "i") return "<em>" + this.inlineHTML(tk.c, msg) + "</em>";
			if (tk.t === "page") return this.citationHTML(tk.v, msg, true);
			if (tk.t === "src") return this.citationHTML(tk.v, msg, false);
			return "";
		}).join("");
	},

	markdownHTML(text, msg) {
		let inline = s => this.inlineHTML(this.inlineTokens(s), msg);
		return this.mdBlocks(text).map(b => {
			if (b.type === "p") return "<p>" + inline(b.lines.join("\n")) + "</p>";
			if (b.type === "h") return "<h3>" + inline(b.text) + "</h3>";
			if (b.type === "hr") return "<hr/>";
			if (b.type === "quote") return "<blockquote><p>" + inline(b.lines.join("\n")) + "</p></blockquote>";
			if (b.type === "code") return "<pre>" + this.esc(b.lines.join("\n")) + "</pre>";
			if (b.type === "ul" || b.type === "ol") {
				return "<" + b.type + ">" + b.items.map(it => "<li>" + inline(it) + "</li>").join("")
					+ "</" + b.type + ">";
			}
			if (b.type === "table") {
				return "<table>" + b.rows.map((row, r) => "<tr>" + row.map(c => {
					let tag = r === 0 ? "th" : "td";
					return "<" + tag + ">" + inline(c) + "</" + tag + ">";
				}).join("") + "</tr>").join("") + "</table>";
			}
			return "";
		}).join("\n");
	},

	async saveNote(conv, messages) {
		let item = this.convItem(conv);
		let top = this.topItem(item);
		if (!top) return;
		let lib = Zotero.Libraries.get(top.libraryID);
		if (lib && lib.editable === false) {
			toast("Annota", "This library is read-only — the note can't be saved.", "error");
			return;
		}
		let title = top.getDisplayTitle ? top.getDisplayTitle() : "";
		let html = ["<h1>" + this.esc("💬 " + (title || "Annota chat")) + "</h1>"];
		for (let m of messages) {
			if (m.role === "user") {
				html.push("<p><strong>Question</strong></p><blockquote>"
					+ this.markdownHTML(m.content, null) + "</blockquote>");
			}
			else {
				html.push(this.markdownHTML(m.content, m));
				let meta = [this.PROVIDER_LABELS[m.provider], m.model].filter(Boolean).join(" · ");
				if (meta) html.push("<p><em>" + this.esc("Annota · " + meta) + "</em></p>");
			}
		}
		let note = new Zotero.Item("note");
		note.libraryID = top.libraryID;
		if (top.isRegularItem && top.isRegularItem()) note.parentID = top.id;
		note.setNote(html.join("\n"));
		await note.saveTx();
		toast("Annota", note.parentID ? "Saved as a note under this reference."
			: "Saved as a standalone note.");
	},

	// ---- Citations depuis le lecteur ----

	quoteText(text, pageLabel) {
		let t = String(text || "").replace(/\s+/g, " ").trim();
		if (!t) return "";
		return "> " + t + (pageLabel ? " [p. " + pageLabel + "]" : "") + "\n\n";
	},

	// Panneau où déposer une citation : de préférence celui qui est visible.
	instanceFor(key) {
		let all = Array.from(this._instances.values()).filter(i => i.key === key);
		return all.find(i => {
			try { return i.body.getClientRects().length > 0; }
			catch (e) { return false; }
		}) || all[0] || null;
	},

	addQuote(attachmentID, quote) {
		if (!quote) return;
		let att = Zotero.Items.get(attachmentID);
		let key = att ? this.keyFor(att) : null;
		if (!key) return;
		let conv = this.conversation(att);
		if (conv) conv.scope = "document";
		let inst = this.instanceFor(key);
		if (inst) {
			this.insertQuote(inst, quote);
			this.renderInstance(inst);
			this.reveal(inst);
			return;
		}
		let list = this._pendingQuotes.get(key) || [];
		list.push(quote);
		this._pendingQuotes.set(key, list);
		toast("Annota", "Quote added — open “Annota Chat” in the item pane to ask about it.");
	},

	takeQuotes(inst) {
		let list = this._pendingQuotes.get(inst.key);
		if (!list || !list.length) return;
		this._pendingQuotes.delete(inst.key);
		for (let q of list) this.insertQuote(inst, q);
	},

	insertQuote(inst, quote) {
		let cur = inst.input.value;
		inst.input.value = cur && !/\n\s*$/.test(cur) ? cur + "\n\n" + quote : cur + quote;
		try {
			inst.input.focus();
			let n = inst.input.value.length;
			inst.input.setSelectionRange(n, n);
		}
		catch (e) {}
	},

	// Montre le panneau : volet de droite déplié, section ouverte et visible.
	// Toutes ces accroches sont internes à Zotero, d'où les vérifications.
	reveal(inst) {
		try {
			let win = inst.doc.defaultView;
			let cp = win && win.ZoteroContextPane;
			if (cp && cp.collapsed === true && typeof cp.togglePane === "function") cp.togglePane();
		}
		catch (e) {}
		try {
			let section = inst.body.closest("collapsible-section");
			if (section && section.open === false) section.open = true;
		}
		catch (e) {}
		try {
			let details = inst.body.closest("item-details");
			if (details && typeof details.scrollToPane === "function" && this.paneID) {
				details.scrollToPane(this.paneID);
			}
			else inst.body.scrollIntoView({ block: "start" });
		}
		catch (e) {}
		try { inst.input.focus(); } catch (e) {}
	},

	// Bouton du popup de sélection du lecteur.
	renderAskButton({ reader, doc, params, append }) {
		if (!getPref("chatSelectionButton", true) || !reader || !doc || !append) return;
		let ann = params && params.annotation;
		let text = String((ann && ann.text) || "").trim();
		if (!text) return;
		let page = (ann && ann.pageLabel)
			|| (ann && ann.position && typeof ann.position.pageIndex === "number"
				? String(ann.position.pageIndex + 1) : "");
		let btn = doc.createElement("button");
		btn.type = "button";
		btn.textContent = "💬 Ask Annota";
		btn.title = "Quote this passage in the Annota chat";
		btn.style.cssText = "width:100%;box-sizing:border-box;margin-top:4px;"
			+ "padding:3px 6px;font:inherit;font-size:11.5px;cursor:pointer;"
			+ "border:1px solid rgba(128,128,128,.45);border-radius:4px;"
			+ "background:rgba(128,128,128,.12);color:inherit;";
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.addQuote(reader.itemID, this.quoteText(text, page));
		});
		append(btn);
	},

	// Entrée du menu contextuel des annotations du lecteur.
	async quoteAnnotations(reader, keys) {
		let att = await Zotero.Items.getAsync(reader.itemID);
		if (!att) return;
		let quote = "";
		for (let key of keys) {
			let a = await Zotero.Items.getByLibraryAndKeyAsync(att.libraryID, key);
			if (!a || !(a.isAnnotation && a.isAnnotation())) continue;
			let text = String(a.annotationText || "").trim();
			let comment = this.htmlToText(a.annotationComment || "");
			if (text) quote += this.quoteText(text, a.annotationPageLabel);
			if (comment) quote += "My comment: " + comment + "\n\n";
		}
		this.addQuote(att.id, quote);
	},

	// ---- Styles ----

	ensureStyles(doc) {
		if (!doc || doc.getElementById("annota-chat-style")) return;
		let st = doc.createElementNS(this.HTML_NS, "style");
		st.id = "annota-chat-style";
		st.textContent = `
.annota-chat { display:flex; flex-direction:column; gap:6px; font-size:12.5px; min-width:0; }
.annota-chat-bar { display:flex; gap:6px; flex-wrap:wrap; }
.annota-chat-select { flex:1 1 9em; min-width:0; font:inherit; font-size:12px; }
.annota-chat-sub { font-size:11px; opacity:.65; min-width:0; }
.annota-chat-sub-text { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.annota-chat-log { display:flex; flex-direction:column; gap:8px; max-height:60vh; overflow-y:auto;
  padding:2px 1px; user-select:text; -moz-user-select:text; }
.annota-chat-msg { padding:6px 9px; border-radius:8px; line-height:1.45; overflow-wrap:anywhere; }
.annota-chat-user { align-self:flex-end; max-width:92%;
  background:color-mix(in srgb, var(--accent-blue, #4072e5) 16%, transparent); }
.annota-chat-assistant { background:var(--fill-quinary, rgba(128,128,128,.10)); }
.annota-chat-error { background:rgba(220,60,60,.10); border:1px solid rgba(220,60,60,.35); }
.annota-chat-md > :first-child { margin-top:0; }
.annota-chat-md > :last-child { margin-bottom:0; }
.annota-chat-md p { margin:0 0 6px; }
.annota-chat-md .annota-chat-h { font-weight:600; margin:8px 0 4px; }
.annota-chat-md ul, .annota-chat-md ol { margin:0 0 6px; padding-inline-start:18px; }
.annota-chat-md li { margin:1px 0; }
.annota-chat-md blockquote { margin:0 0 6px; padding-inline-start:8px;
  border-inline-start:3px solid rgba(128,128,128,.5); opacity:.85; }
.annota-chat-md pre { white-space:pre-wrap; margin:0 0 6px; padding:6px; border-radius:4px;
  background:rgba(128,128,128,.12); font-size:11.5px; }
.annota-chat-md code { font-family:monospace; font-size:.95em; }
.annota-chat-md table { border-collapse:collapse; margin:0 0 6px; font-size:11.5px; }
.annota-chat-md th, .annota-chat-md td { border:1px solid rgba(128,128,128,.35); padding:2px 5px;
  text-align:start; vertical-align:top; }
.annota-chat-md hr { border:none; border-top:1px solid rgba(128,128,128,.35); margin:6px 0; }
.annota-chat-cite { color:var(--accent-blue, #4072e5); cursor:pointer; }
.annota-chat-cite:hover, .annota-chat-cite:focus { text-decoration:underline; }
.annota-chat-actions { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center;
  margin-top:5px; font-size:11px; }
.annota-chat-meta { opacity:.55; }
.annota-chat-link { appearance:none; background:none; border:none; padding:0; font:inherit;
  font-size:11px; color:inherit; opacity:.7; cursor:pointer; text-decoration:underline; }
.annota-chat-link:hover { opacity:1; }
.annota-chat-tools { display:flex; gap:12px; justify-content:flex-end; }
.annota-chat-status { font-size:11px; opacity:.7; }
.annota-chat-status:empty { display:none; }
.annota-chat-form { display:flex; gap:6px; align-items:flex-end; }
.annota-chat-input { flex:1; min-width:0; min-height:3.4em; resize:vertical; box-sizing:border-box;
  font:inherit; font-size:12.5px; padding:5px 7px; border-radius:6px; color:inherit;
  border:1px solid rgba(128,128,128,.45); background:var(--material-background, Field); }
.annota-chat-send { font:inherit; font-size:12px; padding:5px 12px; border-radius:6px; cursor:pointer; }
.annota-chat-send[data-busy="true"] { color:rgb(200,50,50); }
.annota-chat-empty { display:flex; flex-direction:column; gap:6px; font-size:12px; opacity:.85; }
.annota-chat-suggest { display:flex; flex-wrap:wrap; gap:4px; }
.annota-chat-chip { appearance:none; font:inherit; font-size:11px; padding:2px 9px; cursor:pointer;
  border:1px solid rgba(128,128,128,.4); border-radius:10px; background:none; color:inherit; }
.annota-chat-chip:hover { background:rgba(128,128,128,.14); }
`;
		let host = doc.head || doc.documentElement;
		if (host) host.appendChild(st);
	}
};
