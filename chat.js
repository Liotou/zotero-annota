/* eslint-disable no-undef */
// Annota — discussion avec le document ouvert ou avec la bibliothèque.
//
// Chargé par bootstrap.js dans sa propre portée globale : Annota, getPref, log
// et toast y sont visibles.
//
// Présentation calquée sur Beaver : un panneau latéral pleine hauteur qui
// prend la place du volet de droite, dans la bibliothèque (#zotero-item-pane)
// comme dans le lecteur (#zotero-context-pane). Un bouton de la barre des
// onglets et ⌘/Ctrl+J l'ouvrent et le ferment ; le volet de Zotero revient tel
// qu'il était à la fermeture.
//
// Aucun fournisseur nouveau : la discussion emploie ceux déjà réglés pour les
// annotations (API, Ollama, Claude CLI, Apple). Elle peut en choisir un autre,
// et un autre modèle, sans rien changer aux annotations.
//
// Deux portées :
//   document     texte intégral page par page, annotations, notes et notice ;
//                le modèle cite les pages [p. 12], rendues en pastilles qui
//                ouvrent la page.
//   bibliothèque recherche Zotero sur les mots de la question ; le modèle cite
//                les items [1], [2], pastilles qui sélectionnent l'item.

var AnnotaChat = {
	HTML_NS: "http://www.w3.org/1999/xhtml",
	SVG_NS: "http://www.w3.org/2000/svg",
	PLUGIN_ID: "annota@equiriconi",

	_windows: new Map(),         // fenêtre principale → { button, panes, visible… }
	_conversations: new Map(),   // clé (référence ou bibliothèque) → conversation
	_pageCache: new Map(),       // id de pièce jointe → { pages, paged, source }
	_notifierID: null,
	_hidden: new WeakMap(),      // élément masqué → display d'origine

	// Au-delà, l'extraction page par page coûte plus qu'elle ne rapporte.
	MAX_PAGES: 600,

	PROVIDER_LABELS: {
		openai: "Mistral / API",
		ollama: "Ollama",
		cli: "Claude Code",
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

	// Effort propre à la discussion (Claude CLI) ; "" = celui de l'onglet AI.
	chatEffort(p) {
		return p === "cli" ? String(getPref("chatCliEffort", "") || "").trim() : "";
	},

	modelLabel(p) {
		if (p === "apple") return "on-device";
		if (p === "cli") {
			let m = this.chatModel(p) || String(getPref("cliModel", "") || "").trim()
				|| "default model";
			let e = this.chatEffort(p) || String(getPref("cliEffort", "") || "").trim();
			return e ? m + " · " + e + " effort" : m;
		}
		let m = this.chatModel(p);
		if (m) return m;
		return Annota.chatConfig(p).model;
	},

	budget(p) {
		let n = parseInt(getPref("chatMaxChars", 0), 10);
		if (n > 0) return Math.max(2000, n);
		return this.AUTO_BUDGET[p] || 40000;
	},

	// ---- Panneau latéral : installation par fenêtre ----

	register() {
		// Changement d'onglet : le volet de Zotero peut se réafficher, et le
		// contexte (quel PDF ?) change.
		try {
			this._notifierID = Zotero.Notifier.registerObserver({
				notify: (event, type) => {
					if (type !== "tab") return;
					for (let rec of this._windows.values()) {
						rec.win.setTimeout(() => {
							try { this.apply(rec); this.refreshContexts(rec); }
							catch (e) { log("discussion, onglet : " + e); }
						}, 60);
					}
				}
			}, ["tab"], "annota-chat");
		}
		catch (e) { log("discussion : observateur d'onglets : " + e); }
	},

	unregister() {
		for (let conv of this._conversations.values()) {
			if (conv.cancel) conv.cancel.cancel();
		}
		if (this._notifierID) {
			try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) {}
			this._notifierID = null;
		}
		for (let win of Array.from(this._windows.keys())) this.removeFromWindow(win);
		this._conversations.clear();
		this._pageCache.clear();
	},

	shortcutKey() {
		let k = String(getPref("chatShortcut", "J") || "").trim();
		return k ? k.slice(0, 1).toLowerCase() : "";
	},

	shortcutLabel() {
		let k = this.shortcutKey().toUpperCase();
		if (!k) return "";
		return Zotero.isMac ? "⌘" + k : "Ctrl+" + k;
	},

	addToWindow(win) {
		if (this._windows.has(win)) return;
		let doc = win.document;
		this.ensureStyles(doc);
		let rec = { win, visible: false, timer: null, panes: {}, uncollapsed: {} };

		// Bouton de la barre des onglets, avant la synchronisation (comme Beaver).
		let toolbar = doc.getElementById("zotero-tabs-toolbar");
		if (toolbar) {
			let btn = doc.createXULElement("toolbarbutton");
			btn.id = "annota-tb-chat";
			let sc = this.shortcutLabel();
			btn.setAttribute("tooltiptext", "Annota Chat" + (sc ? " (" + sc + ")" : ""));
			btn.setAttribute("aria-label", "Annota Chat");
			btn.addEventListener("command", () => this.toggle(win));
			let sync = toolbar.querySelector("#zotero-tb-sync");
			if (sync) toolbar.insertBefore(btn, sync);
			else toolbar.appendChild(btn);
			rec.button = btn;
		}

		let mount = (id, location, parent) => {
			if (!parent) return;
			let box = doc.createXULElement("vbox");
			box.id = id;
			box.setAttribute("class", "annota-pane");
			box.style.display = "none";
			parent.appendChild(box);
			rec.panes[location] = { box, inst: this.mount(box, location, win) };
		};
		mount("annota-pane-library", "library", doc.getElementById("zotero-item-pane"));
		mount("annota-pane-reader", "reader", doc.getElementById("zotero-context-pane"));

		// ⌘/Ctrl+J, comme Beaver. Inopérant quand le PDF a le focus : le
		// lecteur est un document à part, dont les touches ne remontent pas.
		rec.onKey = (e) => {
			let key = this.shortcutKey();
			if (!key || e.defaultPrevented || e.shiftKey || e.altKey) return;
			let accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
			if (!accel || String(e.key).toLowerCase() !== key) return;
			e.preventDefault();
			this.toggle(win);
		};
		win.addEventListener("keydown", rec.onKey);

		this._windows.set(win, rec);
	},

	removeFromWindow(win) {
		let rec = this._windows.get(win);
		if (!rec) return;
		try { if (rec.visible) { rec.visible = false; this.apply(rec); } } catch (e) {}
		if (rec.timer) { try { win.clearInterval(rec.timer); } catch (e) {} }
		try { win.removeEventListener("keydown", rec.onKey); } catch (e) {}
		try { if (rec.button) rec.button.remove(); } catch (e) {}
		for (let p of Object.values(rec.panes)) { try { p.box.remove(); } catch (e) {} }
		try {
			let st = win.document.getElementById("annota-chat-style");
			if (st) st.remove();
		}
		catch (e) {}
		this._windows.delete(win);
	},

	tabType(win) {
		try {
			let t = win.Zotero_Tabs && win.Zotero_Tabs.selectedType;
			if (t) return String(t).startsWith("reader") ? "reader" : "library";
			return win.Zotero_Tabs.selectedID === "zotero-pane" ? "library" : "reader";
		}
		catch (e) { return "library"; }
	},

	toggle(win, force) {
		let rec = this._windows.get(win);
		if (!rec) return;
		rec.visible = (force === undefined) ? !rec.visible : !!force;
		this.apply(rec);
		if (rec.visible) {
			this.refreshContexts(rec);
			// Le contexte suit la sélection : un relevé léger, seulement tant
			// que le panneau est ouvert (Zotero n'expose pas d'événement de
			// sélection stable aux modules).
			if (!rec.timer) rec.timer = win.setInterval(() => this.refreshContexts(rec), 700);
			let inst = this.activeInstance(rec);
			if (inst) win.setTimeout(() => { try { inst.input.focus(); } catch (e) {} }, 50);
		}
		else if (rec.timer) {
			win.clearInterval(rec.timer);
			rec.timer = null;
		}
	},

	activeInstance(rec) {
		let p = rec.panes[this.tabType(rec.win)];
		return p ? p.inst : null;
	},

	hideEl(el) {
		if (!el || !el.style) return;
		if (!this._hidden.has(el)) this._hidden.set(el, el.style.display || "");
		el.style.display = "none";
	},

	restoreEl(el) {
		if (!el || !el.style || !this._hidden.has(el)) return;
		let d = this._hidden.get(el);
		this._hidden.delete(el);
		if (d) el.style.display = d;
		else el.style.removeProperty("display");
	},

	// Affiche le panneau à la place du volet de Zotero, ou rend le volet.
	apply(rec) {
		let { win } = rec, doc = win.document;
		let show = rec.visible;
		let tab = this.tabType(win);
		if (rec.button) {
			rec.button.toggleAttribute("selected", show);
			rec.button.setAttribute("aria-pressed", show ? "true" : "false");
		}

		// Bibliothèque.
		let lib = rec.panes.library;
		let itemPane = doc.getElementById("zotero-item-pane");
		if (lib && itemPane) {
			let zp = win.ZoteroPane && win.ZoteroPane.itemPane;
			if (show) {
				if (tab === "library" && zp && zp.collapsed) {
					zp.collapsed = false;
					rec.uncollapsed.library = true;
				}
				for (let c of Array.from(itemPane.children)) if (c !== lib.box) this.hideEl(c);
				lib.box.style.display = "flex";
			}
			else {
				for (let c of Array.from(itemPane.children)) if (c !== lib.box) this.restoreEl(c);
				lib.box.style.display = "none";
				if (rec.uncollapsed.library && zp) zp.collapsed = true;
				rec.uncollapsed.library = false;
			}
		}

		// Lecteur. En disposition empilée, le volet de contexte occupe tout
		// le lecteur : le panneau se loge alors dans sa bande inférieure.
		let rd = rec.panes.reader;
		let ctxPane = doc.getElementById("zotero-context-pane");
		if (rd && ctxPane) {
			let ctxInner = doc.getElementById("zotero-context-pane-inner");
			let stacked = Zotero.Prefs.get("layout") === "stacked";
			let target = stacked && ctxInner ? ctxInner : ctxPane;
			for (let parent of [ctxPane, ctxInner]) {
				if (!parent) continue;
				for (let c of Array.from(parent.children)) if (c !== rd.box) this.restoreEl(c);
			}
			if (rd.box.parentNode !== target) target.appendChild(rd.box);
			let cp = win.ZoteroContextPane;
			if (show) {
				if (tab === "reader" && cp && cp.collapsed && typeof cp.togglePane === "function") {
					cp.togglePane();
					rec.uncollapsed.reader = true;
				}
				for (let c of Array.from(target.children)) if (c !== rd.box) this.hideEl(c);
				rd.box.style.display = "flex";
			}
			else {
				rd.box.style.display = "none";
				if (rec.uncollapsed.reader && cp && !cp.collapsed
						&& typeof cp.togglePane === "function") {
					cp.togglePane();
				}
				rec.uncollapsed.reader = false;
			}
		}
	},

	// ---- Contexte courant ----

	// Référence dont on parle : le PDF de l'onglet de lecture, ou l'item
	// sélectionné dans la bibliothèque. Sans sélection unique, la bibliothèque.
	contextFor(inst) {
		let win = inst.win;
		if (inst.location === "reader") {
			try {
				let tabID = win.Zotero_Tabs.selectedID;
				let reader = typeof Zotero.Reader.getByTabID === "function"
					? Zotero.Reader.getByTabID(tabID)
					: (Zotero.Reader._readers || []).find(r => r.tabID === tabID);
				let att = reader ? Zotero.Items.get(reader.itemID) : null;
				if (att) return { item: att, libraryID: att.libraryID };
			}
			catch (e) {}
			return null;
		}
		let items = [], libraryID = Zotero.Libraries.userLibraryID;
		try {
			items = win.ZoteroPane.getSelectedItems() || [];
			libraryID = win.ZoteroPane.getSelectedLibraryID() || libraryID;
		}
		catch (e) {}
		if (items.length === 1) return { item: items[0], libraryID: items[0].libraryID };
		return { item: null, libraryID };
	},

	refreshContexts(rec) {
		if (!rec.visible) return;
		let inst = this.activeInstance(rec);
		if (!inst) return;
		let ctx = this.contextFor(inst);
		if (!ctx) return;
		let key = ctx.item ? this.keyFor(ctx.item) : "lib:" + ctx.libraryID;
		if (key && key !== inst.key) this.show(inst, ctx, key);
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

	conversation(ctx, key) {
		let conv = this._conversations.get(key);
		if (!conv) {
			conv = { key, itemID: ctx.item ? ctx.item.id : null, libraryID: ctx.libraryID,
				messages: [], scope: ctx.item ? "document" : "library",
				busy: false, cancel: null, error: null, status: "" };
			this._conversations.set(key, conv);
		}
		return conv;
	},

	convItem(conv) {
		return conv && conv.itemID ? Zotero.Items.get(conv.itemID) : null;
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

	async buildLibraryContext(libraryID, terms, budget) {
		libraryID = libraryID || Zotero.Libraries.userLibraryID;
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
			conv.error = { message: notReady + " Pick another model below, or set it up in"
				+ " Settings → Annota → ✨ AI." };
			this.refresh(conv);
			return;
		}
		conv.messages.push({ role: "user", content: text });
		inst.input.value = "";
		this.autoGrow(inst);
		await this.answer(conv);
	},

	async answer(conv) {
		let p = this.provider();
		let item = this.convItem(conv);
		// Sans référence sélectionnée, seule la bibliothèque a un sens.
		if (!item) conv.scope = "library";
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
				ctx = await this.buildLibraryContext(conv.libraryID, terms, Math.floor(budget * 0.8));
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
				effort: this.chatEffort(p) || undefined,
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

	// Icônes au trait (16 px), dessinées en currentColor : elles suivent le
	// thème clair ou sombre de Zotero.
	ICONS: {
		close: ["M4 4l8 8", "M12 4l-8 8"],
		plus: ["M8 3v10", "M3 8h10"],
		note: ["M3.5 2.5h9v11h-9z", "M5.75 6h4.5", "M5.75 8.5h4.5", "M5.75 11h2.5"],
		settings: ["M2.5 5h11", "M2.5 11h11", "#c6 5 1.6", "#c10 11 1.6"],
		copy: ["M5.5 5.5h8v8h-8z", "M10.5 5.5v-3h-8v8h3"],
		up: ["M8 13V3.5", "M4 7.5l4-4 4 4"],
		stop: ["#r4.5 4.5 7 7"],
		doc: ["M4 1.75h5.25l2.75 2.75v9.75H4z", "M9.25 1.75V4.5H12"],
		library: ["M3 2.5v11", "M6 2.5v11", "M8.75 3.1l3.25 10.4"],
		chat: ["M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 11.5H8.5L5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"],
		retry: ["M13 8a5 5 0 1 1-1.46-3.54", "M13 2.5v3h-3"],
		check: ["M3.5 8.5l3 3 6-7"]
	},

	icon(doc, name, size = 16) {
		let svg = doc.createElementNS(this.SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("width", String(size));
		svg.setAttribute("height", String(size));
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.4");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		for (let d of this.ICONS[name] || []) {
			let shape;
			if (d.startsWith("#c")) {
				let [cx, cy, r] = d.slice(2).split(" ");
				shape = doc.createElementNS(this.SVG_NS, "circle");
				shape.setAttribute("cx", cx);
				shape.setAttribute("cy", cy);
				shape.setAttribute("r", r);
				shape.setAttribute("fill", "var(--annota-surface, Field)");
			}
			else if (d.startsWith("#r")) {
				let [x, y, w, h] = d.slice(2).split(" ");
				shape = doc.createElementNS(this.SVG_NS, "rect");
				shape.setAttribute("x", x);
				shape.setAttribute("y", y);
				shape.setAttribute("width", w);
				shape.setAttribute("height", h);
				shape.setAttribute("rx", "1.5");
				shape.setAttribute("fill", "currentColor");
				shape.setAttribute("stroke", "none");
			}
			else {
				shape = doc.createElementNS(this.SVG_NS, "path");
				shape.setAttribute("d", d);
			}
			svg.appendChild(shape);
		}
		return svg;
	},

	button(doc, label, cls, onClick, title) {
		let b = this.el(doc, "button", cls || "annota-btn", label);
		b.setAttribute("type", "button");
		if (title) {
			b.setAttribute("title", title);
			b.setAttribute("aria-label", title);
		}
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!b.disabled) onClick(e);
		});
		return b;
	},

	iconButton(doc, name, title, onClick, cls) {
		let b = this.button(doc, null, "annota-icon-btn" + (cls ? " " + cls : ""), onClick, title);
		b.appendChild(this.icon(doc, name));
		return b;
	},

	mount(box, location, win) {
		let doc = box.ownerDocument;
		this.ensureStyles(doc);
		let root = this.el(doc, "div", "annota-chat");

		// En-tête : fermer et nouvelle discussion à gauche, actions à droite.
		let header = this.el(doc, "div", "annota-chat-header");
		let left = this.el(doc, "div", "annota-chat-header-group");
		let right = this.el(doc, "div", "annota-chat-header-group");
		let sc = this.shortcutLabel();
		left.appendChild(this.iconButton(doc, "close", "Close" + (sc ? " (" + sc + ")" : ""),
			() => this.toggle(win, false)));
		let newBtn = this.iconButton(doc, "plus", "New chat", () => {
			let conv = this.conversationOf(inst);
			if (!conv || conv.busy) return;
			conv.messages = [];
			conv.error = null;
			this.refresh(conv);
			inst.input.focus();
		});
		left.appendChild(newBtn);
		let title = this.el(doc, "div", "annota-chat-title", "Annota");
		let saveBtn = this.iconButton(doc, "note", "Save chat as note", () => {
			let conv = this.conversationOf(inst);
			if (conv && conv.messages.length) {
				this.saveNote(conv, conv.messages).catch(e => log("saveNote: " + e));
			}
		});
		right.appendChild(saveBtn);
		right.appendChild(this.iconButton(doc, "settings", "Chat settings", () => this.openSettings()));
		header.appendChild(left);
		header.appendChild(title);
		header.appendChild(right);

		// Fil de la discussion.
		let scroller = this.el(doc, "div", "annota-chat-scroll");
		let thread = this.el(doc, "div", "annota-chat-thread");
		scroller.appendChild(thread);

		// Zone de saisie : une carte, comme celle de Beaver.
		let dock = this.el(doc, "div", "annota-chat-dock");
		let card = this.el(doc, "div", "annota-composer");
		let chips = this.el(doc, "div", "annota-composer-chips");
		let docChip = this.button(doc, null, "annota-chip", () => this.setScope(inst, "document"));
		docChip.appendChild(this.icon(doc, "doc", 13));
		let docLabel = this.el(doc, "span", "annota-chip-label", "This document");
		docChip.appendChild(docLabel);
		let libChip = this.button(doc, null, "annota-chip", () => this.setScope(inst, "library"));
		libChip.appendChild(this.icon(doc, "library", 13));
		let libLabel = this.el(doc, "span", "annota-chip-label", "My library");
		libChip.appendChild(libLabel);
		chips.appendChild(docChip);
		chips.appendChild(libChip);

		let input = this.el(doc, "textarea", "annota-composer-input");
		input.setAttribute("rows", "1");
		input.setAttribute("aria-label", "Message Annota");

		let controls = this.el(doc, "div", "annota-composer-controls");
		let modelSel = this.el(doc, "select", "annota-model-select");
		modelSel.setAttribute("title", "AI used for the chat — set up in Settings → Annota → ✨ AI");
		let spacer = this.el(doc, "div", "annota-flex");
		let send = this.button(doc, null, "annota-send", () => {
			let conv = this.conversationOf(inst);
			if (conv && conv.busy) this.stop(conv);
			else this.submit(inst, input.value);
		}, "Send");
		controls.appendChild(modelSel);
		controls.appendChild(spacer);
		controls.appendChild(send);

		card.appendChild(chips);
		card.appendChild(input);
		card.appendChild(controls);
		dock.appendChild(card);

		root.appendChild(header);
		root.appendChild(scroller);
		root.appendChild(dock);
		box.appendChild(root);

		let inst = { win, doc, box, root, location, thread, scroller, input, send, modelSel,
			docChip, docLabel, libChip, libLabel, newBtn, saveBtn, key: null, ctx: null };

		// Le lecteur et la fenêtre principale ont leurs raccourcis : la frappe
		// s'arrête au panneau (sauf le raccourci qui le ferme).
		for (let type of ["keydown", "keypress", "keyup"]) {
			root.addEventListener(type, (e) => {
				let accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
				if (type === "keydown" && accel && String(e.key).toLowerCase() === this.shortcutKey()) return;
				if (type === "keydown" && e.key === "Escape" && !inst.input.value) {
					this.toggle(win, false);
				}
				e.stopPropagation();
			});
		}
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				let conv = this.conversationOf(inst);
				if (conv && !conv.busy) this.submit(inst, input.value);
			}
		});
		input.addEventListener("input", () => {
			this.autoGrow(inst);
			this.updateSend(inst);
		});
		modelSel.addEventListener("change", () => {
			Zotero.Prefs.set("annota.chatProvider", modelSel.value || "");
			for (let rec of this._windows.values()) {
				for (let p of Object.values(rec.panes)) this.fillModels(p.inst);
			}
		});

		this.fillModels(inst);
		return inst;
	},

	openSettings() {
		try {
			Zotero.Utilities.Internal.openPreferences(Annota.prefPaneID || undefined);
		}
		catch (e) { log("openSettings: " + e); }
	},

	autoGrow(inst) {
		let t = inst.input;
		t.style.height = "auto";
		t.style.height = Math.min(t.scrollHeight, 180) + "px";
	},

	updateSend(inst) {
		let conv = this.conversationOf(inst);
		let busy = !!(conv && conv.busy);
		inst.send.textContent = "";
		inst.send.appendChild(this.icon(inst.doc, busy ? "stop" : "up", busy ? 12 : 15));
		inst.send.setAttribute("data-busy", busy ? "true" : "false");
		inst.send.setAttribute("title", busy ? "Stop" : "Send (Enter)");
		inst.send.disabled = !busy && !inst.input.value.trim();
	},

	conversationOf(inst) {
		return inst && inst.key ? this._conversations.get(inst.key) || null : null;
	},

	setScope(inst, scope) {
		let conv = this.conversationOf(inst);
		if (!conv || conv.busy) return;
		if (scope === "document" && !conv.itemID) return;
		conv.scope = scope;
		this.refresh(conv);
		inst.input.focus();
	},

	// Menu des IA : celles déjà réglées dans l'onglet ✨ AI, avec le modèle
	// que la discussion emploiera.
	fillModels(inst) {
		let sel = inst.modelSel;
		let stored = String(getPref("chatProvider", "") || "").trim();
		if (!Annota.PROVIDERS.includes(stored)) stored = "";
		sel.textContent = "";
		let def = Annota.provider();
		let label = p => this.PROVIDER_LABELS[p] + " · " + this.modelLabel(p);
		let opts = [["", label(def) + " (default)"]]
			.concat(Annota.PROVIDERS.map(p => [p, label(p)]));
		for (let [v, l] of opts) {
			let o = this.el(inst.doc, "option", null,
				l + (v && Annota.providerReadyError(v) ? " — not set up" : ""));
			o.setAttribute("value", v);
			sel.appendChild(o);
		}
		sel.value = stored;
	},

	show(inst, ctx, key) {
		inst.key = key;
		inst.ctx = ctx;
		let conv = this.conversation(ctx, key);
		this.renderInstance(inst);
		this.updateChips(inst);
		this.describeSource(inst, ctx).catch(e => log("describeSource: " + e));
		if (inst.pendingQuote) {
			let q = inst.pendingQuote;
			inst.pendingQuote = null;
			this.insertQuote(inst, q);
		}
		return conv;
	},

	shortTitle(item) {
		let t = "";
		try { t = item.getDisplayTitle ? item.getDisplayTitle() : ""; } catch (e) {}
		return t.length > 40 ? t.slice(0, 38).trim() + "…" : t;
	},

	async describeSource(inst, ctx) {
		let key = inst.key;
		let name = "";
		try {
			let lib = Zotero.Libraries.get(ctx.libraryID);
			name = lib ? lib.name : "";
		}
		catch (e) {}
		inst.libLabel.textContent = name || "My library";
		inst.libChip.setAttribute("title", "Search " + (name || "your library")
			+ " — references, notes, annotations, full text");
		if (!ctx.item) return;
		let top = this.topItem(ctx.item);
		inst.docLabel.textContent = this.shortTitle(top) || "This document";
		let { att } = await this.resolveDocument(ctx.item);
		if (inst.key !== key) return;
		let file = "";
		try { file = att ? (att.attachmentFilename || att.getDisplayTitle()) : ""; } catch (e) {}
		inst.docChip.setAttribute("title", (top ? top.getDisplayTitle() : "")
			+ (file ? "\n" + file : "\nNo PDF or EPUB — reference, notes and annotations only"));
	},

	updateChips(inst) {
		let conv = this.conversationOf(inst);
		if (!conv) return;
		inst.docChip.hidden = !conv.itemID;
		inst.docChip.setAttribute("data-active", conv.scope === "document" ? "true" : "false");
		inst.libChip.setAttribute("data-active", conv.scope === "library" ? "true" : "false");
		inst.input.setAttribute("placeholder", conv.scope === "library"
			? "Ask your library…"
			: "Ask about this document…");
		inst.newBtn.disabled = !conv.messages.length || conv.busy;
		inst.saveBtn.disabled = !conv.messages.length;
	},

	// Toutes les vues ouvertes sur cette conversation (bibliothèque et lecteur
	// peuvent montrer la même référence).
	refresh(conv) {
		if (!conv) return;
		for (let rec of this._windows.values()) {
			for (let p of Object.values(rec.panes)) {
				if (p.inst.key === conv.key) this.renderInstance(p.inst);
			}
		}
	},

	renderInstance(inst) {
		let conv = this.conversationOf(inst);
		if (!conv) return;
		let doc = inst.doc;
		let box = inst.thread;
		box.textContent = "";
		inst.root.setAttribute("data-empty",
			!conv.messages.length && !conv.busy && !conv.error ? "true" : "false");
		if (!conv.messages.length && !conv.busy && !conv.error) {
			box.appendChild(this.renderEmpty(inst, conv));
		}
		conv.messages.forEach((m, i) => box.appendChild(this.renderMessage(inst, conv, m, i)));
		if (conv.busy) {
			let t = this.el(doc, "div", "annota-thinking");
			let dots = this.el(doc, "span", "annota-dots");
			for (let k = 0; k < 3; k++) dots.appendChild(this.el(doc, "span"));
			t.appendChild(dots);
			t.appendChild(this.el(doc, "span", null, conv.status || "Working…"));
			box.appendChild(t);
		}
		if (conv.error) {
			let err = this.el(doc, "div", "annota-error" + (conv.error.stopped ? " annota-stopped" : ""));
			err.appendChild(this.el(doc, "div", null, conv.error.message));
			let last = conv.messages[conv.messages.length - 1];
			if (last && last.role === "user" && !conv.busy) {
				let retry = this.button(doc, null, "annota-link-btn", () => {
					this.answer(conv).catch(e => log("answer: " + e));
				});
				retry.appendChild(this.icon(doc, "retry", 12));
				retry.appendChild(this.el(doc, "span", null, "Retry"));
				err.appendChild(retry);
			}
			box.appendChild(err);
		}
		this.updateChips(inst);
		this.updateSend(inst);
		inst.scroller.scrollTop = inst.scroller.scrollHeight;
	},

	SUGGESTIONS: {
		document: [
			["Summarize", "Summarize this document: question, method, main findings."],
			["Key argument", "What is the main argument, and how is it supported?"],
			["Methods", "Which methods and data does it use?"],
			["Limitations", "What are its limitations, stated or not?"],
			["My highlights", "Summarize my annotations on this document."]
		],
		library: [
			["What do I have on…", "What does my library say about "],
			["Compare", "Compare how the references in my library address "],
			["Find a source", "Which reference in my library would support the claim that "]
		]
	},

	renderEmpty(inst, conv) {
		let doc = inst.doc;
		let wrap = this.el(doc, "div", "annota-home");
		let badge = this.el(doc, "div", "annota-home-icon");
		badge.appendChild(this.icon(doc, "chat", 26));
		wrap.appendChild(badge);
		let item = this.convItem(conv);
		let lib = conv.scope === "library";
		wrap.appendChild(this.el(doc, "div", "annota-home-title",
			lib ? "Ask your library" : "Ask about this document"));
		wrap.appendChild(this.el(doc, "div", "annota-home-sub", lib
			? "Annota searches your references, notes and annotations, and cites them."
			: (this.shortTitle(this.topItem(item)) || "")
				+ " — answers cite pages; click one to jump there."));
		let actions = this.el(doc, "div", "annota-home-actions");
		for (let [label, prompt] of this.SUGGESTIONS[conv.scope] || []) {
			actions.appendChild(this.button(doc, label, "annota-launch", () => {
				// Une suggestion ouverte (« … about ») attend la fin de la phrase.
				if (/\s$/.test(prompt)) {
					inst.input.value = prompt;
					this.autoGrow(inst);
					this.updateSend(inst);
					inst.input.focus();
				}
				else this.submit(inst, prompt);
			}));
		}
		wrap.appendChild(actions);
		if (!lib) {
			wrap.appendChild(this.el(doc, "div", "annota-home-hint",
				"Tip: select text in the PDF and click “💬 Ask Annota” to quote it here."));
		}
		return wrap;
	},

	renderMessage(inst, conv, m, i) {
		let doc = inst.doc;
		if (m.role === "user") {
			let card = this.el(doc, "div", "annota-user");
			card.appendChild(this.renderMarkdown(doc, m.content, null));
			return card;
		}
		let wrap = this.el(doc, "div", "annota-answer");
		wrap.appendChild(this.renderMarkdown(doc, m.content, m));
		let foot = this.el(doc, "div", "annota-answer-foot");
		let copy = this.iconButton(doc, "copy", "Copy", () => {
			try {
				Zotero.Utilities.Internal.copyTextToClipboard(m.content);
				copy.textContent = "";
				copy.appendChild(this.icon(doc, "check"));
				inst.win.setTimeout(() => {
					copy.textContent = "";
					copy.appendChild(this.icon(doc, "copy"));
				}, 1200);
			}
			catch (e) { log("copy: " + e); }
		}, "annota-icon-sm");
		foot.appendChild(copy);
		foot.appendChild(this.iconButton(doc, "note", "Save as note (with its question)", () => {
			let q = conv.messages[i - 1];
			let pair = q && q.role === "user" ? [q, m] : [m];
			this.saveNote(conv, pair).catch(e => log("saveNote: " + e));
		}, "annota-icon-sm"));
		let meta = [this.PROVIDER_LABELS[m.provider] || m.provider, m.model,
			m.seconds != null ? m.seconds + " s" : "", m.note].filter(Boolean).join(" · ");
		foot.appendChild(this.el(doc, "span", "annota-answer-meta", meta));
		wrap.appendChild(foot);
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

	// Pastille de citation : verte pour une page (elle ouvre le PDF à cet
	// endroit), grise pour une référence de la bibliothèque.
	pill(doc, text, title, kind, onClick) {
		let a = this.el(doc, "span", "annota-cite annota-cite-" + kind, text);
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
		let { parts } = this.splitCitation(v, isPage);
		let pills = [];
		for (let part of parts) {
			if (part.sep !== undefined || !part.target) continue;
			if (isPage) {
				if (this.pageIndexFor(msg, part.target) === null) continue;
				pills.push(this.pill(doc, "p. " + part.text.trim(), "Open page " + part.target,
					"page", () => this.openPage(msg, part.target)));
				continue;
			}
			let src = sources.find(s => String(s.n) === part.target);
			if (!src) continue;
			let it = Zotero.Items.get(src.id);
			let title = it && it.getDisplayTitle ? it.getDisplayTitle() : "";
			pills.push(this.pill(doc, part.target, title || "Show in library", "source",
				() => this.selectItem(src.id)));
		}
		if (!pills.length) { parent.appendChild(doc.createTextNode(v)); return; }
		for (let p of pills) parent.appendChild(p);
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
		let top = this.topItem(this.convItem(conv));
		let libraryID = top ? top.libraryID : conv.libraryID;
		let lib = Zotero.Libraries.get(libraryID);
		if (lib && lib.editable === false) {
			toast("Annota", "This library is read-only — the note can't be saved.", "error");
			return;
		}
		let title = top && top.getDisplayTitle ? top.getDisplayTitle() : "";
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
		note.libraryID = libraryID;
		if (top && top.isRegularItem && top.isRegularItem()) note.parentID = top.id;
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

	// Ouvre le panneau et dépose la citation dans la zone de saisie.
	addQuote(attachmentID, quote) {
		if (!quote) return;
		let win = Zotero.getMainWindow();
		let rec = win && this._windows.get(win);
		if (!rec) return;
		this.toggle(win, true);
		let inst = this.activeInstance(rec);
		if (!inst) return;
		let att = Zotero.Items.get(attachmentID);
		let key = att ? this.keyFor(att) : null;
		if (key && inst.key !== key) {
			inst.pendingQuote = quote;
			return;
		}
		let conv = this.conversationOf(inst);
		if (conv && conv.itemID && !conv.busy && conv.scope !== "document") {
			conv.scope = "document";
			this.renderInstance(inst);
		}
		this.insertQuote(inst, quote);
	},

	insertQuote(inst, quote) {
		let cur = inst.input.value;
		inst.input.value = cur && !/\n\s*$/.test(cur) ? cur + "\n\n" + quote : cur + quote;
		this.autoGrow(inst);
		this.updateSend(inst);
		try {
			inst.input.focus();
			let n = inst.input.value.length;
			inst.input.setSelectionRange(n, n);
		}
		catch (e) {}
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
	//
	// Couleurs tirées du thème de Zotero (--material-*, --fill-*, --accent-*) :
	// le panneau suit les thèmes clair, sombre et contraste élevé, comme
	// Beaver qui s'appuie sur les mêmes jetons.

	ensureStyles(doc) {
		if (!doc || doc.getElementById("annota-chat-style")) return;
		let st = doc.createElementNS(this.HTML_NS, "style");
		st.id = "annota-chat-style";
		st.textContent = `
#annota-tb-chat {
  list-style-image: url("${Annota.rootURI}chat.svg");
  -moz-context-properties: fill, fill-opacity;
  fill: var(--fill-secondary);
  width: 28px; height: 28px; padding: 6px; border-radius: 5px;
}
#annota-tb-chat:hover { background-color: var(--fill-quinary); }
#annota-tb-chat:active, #annota-tb-chat[selected] { background-color: var(--fill-quarternary); }

.annota-pane { flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; height: 100%;
  background: var(--material-sidepane, Field); }
.annota-chat { --annota-surface: var(--material-sidepane, Field);
  display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; height: 100%;
  font-size: 13px; color: var(--fill-primary, inherit); }
.annota-chat button { margin: 0; font: inherit; }

.annota-chat-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid var(--fill-quinary, rgba(128,128,128,.2)); }
.annota-chat-header-group { flex: 1 1 0; display: flex; align-items: center; gap: 2px; }
.annota-chat-header-group:last-child { justify-content: flex-end; }
.annota-chat-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--fill-secondary); }

.annota-icon-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px; background: transparent;
  color: var(--fill-secondary); cursor: pointer; }
.annota-icon-btn:hover:not(:disabled) { background: var(--fill-quinary); color: var(--fill-primary); }
.annota-icon-btn:disabled { opacity: .35; cursor: default; }
.annota-icon-btn.annota-icon-sm { width: 22px; height: 22px; border-radius: 5px; }
.annota-icon-btn.annota-icon-sm svg { width: 14px; height: 14px; }

.annota-chat-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.annota-chat-thread { display: flex; flex-direction: column; gap: 14px; padding: 14px 14px 8px;
  box-sizing: border-box; user-select: text; -moz-user-select: text; }
.annota-chat[data-empty="true"] .annota-chat-thread { min-height: 100%; justify-content: center; }

.annota-user { padding: 8px 11px; border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3));
  border-radius: 10px; background: var(--material-mix-quarternary, rgba(128,128,128,.07));
  line-height: 1.5; overflow-wrap: anywhere; }
.annota-answer { line-height: 1.55; padding: 0 2px; overflow-wrap: anywhere; }
.annota-answer-foot { display: flex; align-items: center; gap: 1px; margin: 5px 0 0 -4px;
  opacity: .5; transition: opacity .15s ease; }
.annota-answer:hover .annota-answer-foot, .annota-answer:focus-within .annota-answer-foot { opacity: 1; }
.annota-answer-meta { margin-left: 6px; min-width: 0; font-size: 11px; color: var(--fill-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.annota-chat-md > :first-child { margin-top: 0; }
.annota-chat-md > :last-child { margin-bottom: 0; }
.annota-chat-md p { margin: 0 0 .65em; }
.annota-chat-md .annota-chat-h { font-weight: 600; margin: .9em 0 .35em; }
.annota-chat-md ul, .annota-chat-md ol { margin: 0 0 .65em; padding-inline-start: 1.35em; }
.annota-chat-md li { margin: .2em 0; }
.annota-chat-md blockquote { margin: 0 0 .65em; padding-inline-start: .7em;
  border-inline-start: 3px solid var(--fill-quarternary, rgba(128,128,128,.4)); color: var(--fill-secondary); }
.annota-chat-md pre { white-space: pre-wrap; margin: 0 0 .65em; padding: 7px 9px; border-radius: 6px;
  background: var(--fill-quinary, rgba(128,128,128,.12)); font-size: 12px; }
.annota-chat-md code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em;
  padding: 0 .25em; border-radius: 3px; background: var(--fill-quinary, rgba(128,128,128,.12)); }
.annota-chat-md pre code { padding: 0; background: none; }
.annota-chat-md table { border-collapse: collapse; margin: 0 0 .65em; font-size: 12px; line-height: 1.45; }
.annota-chat-md th, .annota-chat-md td { border: 1px solid var(--fill-quarternary, rgba(128,128,128,.35));
  padding: 3px 6px; text-align: start; vertical-align: top; }
.annota-chat-md th { background: var(--fill-quinary, rgba(128,128,128,.1)); font-weight: 600; }
.annota-chat-md hr { border: none; border-top: 1px solid var(--fill-quinary, rgba(128,128,128,.3)); margin: .8em 0; }
.annota-chat-md strong { font-weight: 600; }

.annota-cite { display: inline-block; cursor: pointer; margin-left: .2em; padding: 0 .4em;
  font-size: .78em; line-height: 1.4; vertical-align: .08em; border-radius: .3em; white-space: nowrap;
  border: 1px solid var(--fill-quinary, rgba(128,128,128,.2));
  background: var(--fill-quinary, rgba(128,128,128,.12)); color: var(--fill-secondary);
  transition: background-color .15s ease, color .15s ease; }
.annota-cite-source:hover, .annota-cite-source:focus { color: var(--fill-primary); }
.annota-cite-page { border-color: #22c55e4d; background: #22c55e0f; color: #22c55ee5; }
.annota-cite-page:hover, .annota-cite-page:focus { background: #22c55e1f; }

.annota-thinking { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fill-secondary); }
.annota-dots { display: inline-flex; gap: 3px; }
.annota-dots span { width: 5px; height: 5px; border-radius: 50%; background: currentColor;
  animation: annota-blink 1.2s infinite ease-in-out both; }
.annota-dots span:nth-child(2) { animation-delay: .15s; }
.annota-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes annota-blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }

.annota-error { display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 8px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.45;
  border: 1px solid #ff66664d; background: #ff66660f; }
.annota-error.annota-stopped { border-color: var(--fill-quarternary, rgba(128,128,128,.3));
  background: transparent; color: var(--fill-secondary); }
.annota-link-btn { appearance: none; display: inline-flex; align-items: center; gap: 4px; padding: 0;
  border: none; background: none; font-size: 12px; color: var(--accent-blue, #4072e5); cursor: pointer; }
.annota-link-btn:hover { text-decoration: underline; }

.annota-chat-dock { flex: none; padding: 6px 10px 10px; }
.annota-composer { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 6px;
  border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3)); border-radius: 10px;
  background: var(--material-mix-quarternary, rgba(128,128,128,.06));
  transition: border-color .15s ease; }
.annota-composer:focus-within { border-color: var(--fill-tertiary, rgba(128,128,128,.5)); }
.annota-composer-chips { display: flex; flex-wrap: nowrap; gap: 5px; min-width: 0; }
.annota-chip { appearance: none; display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  padding: 2px 7px; border-radius: 6px; border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3));
  background: transparent; color: var(--fill-secondary); font-size: 11.5px; cursor: pointer;
  flex: 0 1 auto; min-width: 0; }
.annota-chip svg { flex: none; }
.annota-chip:last-child { flex: 0 0 auto; max-width: 45%; }
.annota-chip:hover { background: var(--fill-quinary); }
.annota-chip[data-active="true"] { background: var(--material-background, Field); color: var(--fill-primary);
  border-color: var(--fill-tertiary, rgba(128,128,128,.5)); }
.annota-chip[hidden] { display: none; }
.annota-chip-label { min-width: 0; max-width: 18em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annota-composer-input { appearance: none; display: block; width: 100%; box-sizing: border-box;
  min-height: 1.5em; max-height: 180px; padding: 2px 0; resize: none; overflow-y: auto;
  border: none; outline: none; background: transparent; color: inherit;
  font: inherit; font-size: 13px; line-height: 1.45; }
.annota-composer-input::placeholder { color: var(--fill-tertiary); }
/* Zotero entoure tout champ focalisé d'un anneau bleu (contour et ombre) ;
   dans la carte de saisie, c'est la carte elle-même qui signale le focus. */
.annota-chat .annota-composer-input,
.annota-chat .annota-composer-input:focus,
.annota-chat .annota-composer-input:focus-visible,
.annota-chat .annota-composer-input:hover {
  outline: none !important; box-shadow: none !important; border: none !important;
  background: transparent !important; -moz-appearance: none !important; appearance: none !important;
  margin: 0 !important; }
.annota-chat .annota-model-select:focus,
.annota-chat .annota-model-select:focus-visible,
.annota-chat .annota-chip:focus,
.annota-chat .annota-launch:focus,
.annota-chat .annota-icon-btn:focus,
.annota-chat .annota-send:focus { outline: none; box-shadow: none; }
.annota-chat .annota-model-select:focus-visible,
.annota-chat .annota-chip:focus-visible,
.annota-chat .annota-launch:focus-visible,
.annota-chat .annota-icon-btn:focus-visible,
.annota-chat .annota-send:focus-visible { background: var(--fill-quinary); }
.annota-composer-controls { display: flex; align-items: center; gap: 4px; margin: 0 -3px; }
.annota-model-select { appearance: none; -moz-appearance: none; min-width: 0; max-width: 80%;
  padding: 3px 6px; border: none; border-radius: 6px; background: transparent;
  color: var(--fill-secondary); font: inherit; font-size: 11.5px; text-overflow: ellipsis; cursor: pointer; }
.annota-model-select:hover, .annota-model-select:focus { background: var(--fill-quinary); color: var(--fill-primary); }
.annota-flex { flex: 1 1 auto; }
.annota-send { appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: none; border-radius: 999px;
  background: var(--accent-blue, #4072e5); color: #fff; cursor: pointer; }
.annota-send:disabled { background: var(--fill-quarternary, rgba(128,128,128,.3)); color: var(--fill-tertiary); cursor: default; }
.annota-send[data-busy="true"] { background: var(--material-background, Field); color: var(--fill-primary);
  border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3)); }
.annota-send svg { stroke-width: 2; }

.annota-home { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px;
  text-align: center; }
.annota-home-icon { display: flex; align-items: center; justify-content: center; width: 46px; height: 46px;
  margin-bottom: 4px; border-radius: 12px; background: var(--fill-quinary, rgba(128,128,128,.12));
  color: var(--fill-secondary); }
.annota-home-title { font-size: 15px; font-weight: 600; }
.annota-home-sub { max-width: 26em; font-size: 12px; line-height: 1.45; color: var(--fill-secondary); }
.annota-home-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 10px; }
.annota-launch { appearance: none; padding: 4px 9px; border-radius: 6px;
  border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3)); background: transparent;
  color: var(--fill-primary, inherit); font-size: 12px; font-weight: 500; cursor: pointer; }
.annota-launch:hover { background: var(--fill-quinary); }
.annota-home-hint { margin-top: 12px; font-size: 11px; color: var(--fill-tertiary, rgba(128,128,128,.8)); }
`;
		let host = doc.head || doc.documentElement;
		if (host) host.appendChild(st);
	}
};
