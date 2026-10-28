/* eslint-disable no-undef */
// Annota : d'une citation de note à son surlignage.
//
// Glisser un surlignage dans une note avec le gabarit « {{citation}} » seul
// donne « (Valkokari, 2015, p. 17) ». Zotero n'y garde que la source et la
// page : « Aller à la page » ouvre la bonne page, pas le passage, et rien du
// tout pour un EPUB sans numéro de page. Ce module :
//
//  1. inscrit dans la citation, au moment du dépôt, la clé du surlignage
//     (citationItems[0].annotationKey et annotationURI). Ariane s'en sert
//     pour faire pointer la citation vers la note d'annotation du coffre ;
//  2. fait ouvrir le surlignage lui-même par « Aller à la page » : encadré
//     comme après un clic, et montré dans le panneau des annotations ;
//  3. ajoute au menu de la citation un bouton « Ouvrir l'annotation », qui
//     sert aussi quand Zotero ne propose pas « Aller à la page ».
//
// Une citation déposée avant ce module n'a pas de clé : on retient alors le
// surlignage de la source à cette page, s'il est le seul.
//
// Tout repose sur des fonctions internes de Zotero (sérialisation des
// annotations, messages de l'éditeur de notes, lecteur). Chaque point
// d'accroche est protégé : s'il disparaît, Zotero retrouve son comportement.

var AnnotaCiteLink = {
	_patched: null,

	start() {
		let U = Zotero.EditorInstanceUtilities;
		let EI = Zotero.EditorInstance;
		if (!U || typeof U.serializeAnnotations !== "function" || !EI || !EI.prototype
			|| typeof EI.prototype.init !== "function") {
			throw new Error("éditeur de notes de Zotero introuvable");
		}
		let self = this;

		let origSerialize = U.serializeAnnotations;
		U.serializeAnnotations = function (annotations, skipEmbeddingItemData) {
			try {
				return self.serializeTagged(origSerialize, this, annotations, skipEmbeddingItemData);
			}
			catch (e) {
				log("citations : clé du surlignage non inscrite : " + e);
				return origSerialize.call(this, annotations, skipEmbeddingItemData);
			}
		};

		// Le gestionnaire de messages de l'éditeur est enregistré pendant
		// init() puis retiré par uninit() sous le même nom : le remplacer
		// AVANT init suffit pour que Zotero pose et retire lui-même le nôtre.
		let origInit = EI.prototype.init;
		EI.prototype.init = function () {
			try { self.wrapHandler(this); }
			catch (e) { log("citations : éditeur non intercepté : " + e); }
			return origInit.apply(this, arguments);
		};

		this._patched = { U, origSerialize, EI, origInit };
		try { this.wrapQuickCopy(); }
		catch (e) { log("citations : glisser hors de Zotero non intercepté : " + e); }
		for (let inst of this.instances()) {
			try { this.adopt(inst); }
			catch (e) { log("citations : éditeur ouvert non intercepté : " + e); }
		}
	},

	stop() {
		for (let inst of this.instances()) {
			try { this.release(inst); }
			catch (e) { /* éditeur déjà fermé */ }
		}
		let p = this._patched;
		if (p) {
			// Notre version est une propriété propre de l'instance unique ; la
			// méthode d'origine vit sur sa classe. Retirer la nôtre suffit,
			// sinon on remet l'originale en place.
			delete p.U.serializeAnnotations;
			if (p.U.serializeAnnotations !== p.origSerialize) {
				p.U.serializeAnnotations = p.origSerialize;
			}
			p.EI.prototype.init = p.origInit;
		}
		this._patched = null;
		if (this._quickCopy) {
			try { Zotero.QuickCopy.getContentFromItems = this._quickCopy; }
			catch (e) { /* Zotero en cours d'arrêt */ }
			this._quickCopy = null;
		}
	},

	// ---- 5. Glisser ou copier un surlignage hors de Zotero ----
	//
	// Le lecteur traduit les surlignages glissés ou copiés en Markdown et en
	// HTML, par une note temporaire (QuickCopy.annotationsToNote) qui passe
	// par serializeAnnotations : ses citations portent donc la clé du
	// surlignage. Les traducteurs « Note Markdown » et « Note HTML » n'en
	// gardent rien et lient la citation à la référence (zotero://select/…).
	// Avec le gabarit « {{citation}} » seul, plus rien ne désigne alors le
	// surlignage. On réécrit donc, dans le texte produit, le lien de chaque
	// citation vers son surlignage, dans la forme même de Zotero :
	// zotero://open-pdf/…/items/PIÈCE?page=N&annotation=CLÉ. Le libellé ne
	// change pas. Ariane, dans Obsidian, y lit la clé.

	_quickCopy: null,

	wrapQuickCopy() {
		let QC = Zotero.QuickCopy;
		if (!QC || typeof QC.getContentFromItems !== "function") {
			throw new Error("QuickCopy.getContentFromItems introuvable");
		}
		let self = this;
		let orig = QC.getContentFromItems;
		QC.getContentFromItems = function (items, format, callback, modified) {
			let links = null;
			try { links = self.annotationLinksFor(items); }
			catch (e) { log("citations : glisser : " + e); }
			if (links && links.length && typeof callback === "function") {
				let cb = callback;
				callback = function (obj, worked) {
					try {
						if (worked && obj && typeof obj.string === "string") {
							obj.string = self.rewriteLinks(obj.string, links);
						}
					}
					catch (e) { log("citations : glisser : " + e); }
					return cb.apply(this, arguments);
				};
			}
			return orig.call(this, items, format, callback, modified);
		};
		this._quickCopy = orig;
	},

	// Citations à clé d'une note temporaire de surlignages, dans l'ordre :
	// [{ itemKey, href }]. null s'il ne s'agit pas d'une telle note.
	annotationLinksFor(items) {
		if (!Array.isArray(items) || items.length !== 1) return null;
		let note = items[0];
		if (!note || !(note.isNote && note.isNote()) || note.id) return null;
		let html = note.getNote();
		if (!html || !html.includes("annotationKey")) return null;
		let out = [], m;
		let re = /<span\b(?=[^>]*\bclass="citation")[^>]*\bdata-citation="([^"]*)"/g;
		while ((m = re.exec(html)) !== null) {
			let ci = null;
			try { ci = (JSON.parse(decodeURIComponent(m[1])).citationItems || [])[0]; }
			catch (e) { ci = null; }
			let uri = ci && ci.uris && ci.uris[0];
			let itemKey = uri && (String(uri).match(/items\/([A-Z0-9]{8})$/) || [])[1];
			let href = ci && ci.annotationKey ? this.annotationOpenURI(ci) : null;
			out.push({ itemKey: itemKey || null, href });
		}
		return out.some(l => l.href) ? out : null;
	},

	// Lien d'ouverture d'un surlignage, construit comme le font les
	// traducteurs de Zotero pour un passage cité.
	annotationOpenURI(ci) {
		let ann = null;
		try {
			let lk = ci.annotationURI ? Zotero.URI.getURIItemLibraryKey(String(ci.annotationURI)) : null;
			if (lk) ann = Zotero.Items.getByLibraryAndKey(lk.libraryID, lk.key);
		}
		catch (e) { ann = null; }
		if (!this.isAnnotation(ann) || !ann.parentItem) return null;
		let att = ann.parentItem;
		let lib = Zotero.Libraries.get(att.libraryID);
		let path = lib && lib.libraryType === "group"
			? "groups/" + Zotero.Groups.getGroupIDFromLibraryID(att.libraryID) : "library";
		let pos = ann.annotationPosition;
		try { if (typeof pos === "string") pos = JSON.parse(pos); }
		catch (e) { pos = null; }
		let href = "zotero://open-pdf/" + path + "/items/" + att.key;
		if (pos && pos.type === "FragmentSelector") href += "?cfi=" + encodeURIComponent(pos.value);
		else if (pos && pos.type === "CssSelector") href += "?sel=" + encodeURIComponent(pos.value);
		else if (pos && typeof pos.pageIndex === "number") href += "?page=" + (pos.pageIndex + 1);
		else href += "?";
		return href + (href.endsWith("?") ? "" : "&") + "annotation=" + ann.key;
	},

	// Remplace, dans l'ordre, le lien zotero://select de chaque citation par
	// celui de son surlignage. Un lien qui ne correspond pas à la citation
	// attendue (autre référence) est laissé tel quel.
	rewriteLinks(text, links) {
		let i = 0;
		let src = String(text);
		return src.replace(/zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Z0-9]{8})/g, (m, key, at) => {
			while (i < links.length && links[i].itemKey && links[i].itemKey !== key) i++;
			let l = links[i++];
			if (!l || !l.href) return m;
			// Parenthèses encodées : un lien Markdown s'arrêterait à celle
			// d'une position EPUB (epubcfi(…)). Dans un attribut HTML, le &
			// s'écrit &amp;, comme Zotero le fait.
			let href = l.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
			return /href="$/.test(src.slice(Math.max(0, at - 6), at)) ? href.replace(/&/g, "&amp;") : href;
		});
	},

	instances() {
		try { return (Zotero.Notes && Zotero.Notes._editorInstances) || []; }
		catch (e) { return []; }
	},

	// ---- 1. La clé du surlignage dans la citation ----

	// Sérialise chaque annotation à part : le HTML produit pour l'une ne peut
	// alors porter que SA citation. Le résultat est identique à un appel
	// groupé (Zotero concatène simplement), clé du surlignage en plus.
	serializeTagged(orig, ctx, annotations, skipEmbeddingItemData) {
		let html = "", citationItems = [];
		for (let a of annotations || []) {
			let res = orig.call(ctx, [a], skipEmbeddingItemData);
			if (!res) continue;
			html += this.tagHTML(res.html || "", a);
			for (let ci of res.citationItems || []) {
				let uris = ci.uris || [];
				if (!citationItems.some(x => (x.uris || []).some(u => uris.includes(u)))) {
					citationItems.push(ci);
				}
			}
		}
		return { html, citationItems };
	},

	tagHTML(html, annotation) {
		let key = annotation && annotation.id;
		if (!key || !/^[A-Z0-9]{8}$/.test(String(key))) return html;
		let att = Zotero.Items.get(annotation.attachmentItemID);
		if (!att) return html;
		let uri = String(Zotero.URI.getItemURI(att)).replace(/[^/]+$/, key);
		return html.replace(/data-citation="([^"]*)"/g, (m, enc) => {
			try {
				let c = JSON.parse(decodeURIComponent(enc));
				let ci = c && c.citationItems && c.citationItems[0];
				if (!ci) return m;
				ci.annotationKey = key;
				ci.annotationURI = uri;
				return 'data-citation="' + encodeURIComponent(JSON.stringify(c)) + '"';
			}
			catch (e) {
				return m;
			}
		});
	},

	// ---- 2. « Aller à la page » ----

	wrapHandler(inst) {
		let orig = inst._messageHandler;
		if (typeof orig !== "function" || orig.__annota) return null;
		let self = this;
		let wrapped = function (e) {
			try {
				if (self.intercept(inst, e, orig)) return undefined;
			}
			catch (err) {
				log("citations : " + err);
			}
			return orig(e);
		};
		wrapped.__annota = true;
		wrapped.__orig = orig;
		inst._messageHandler = wrapped;
		return wrapped;
	},

	// Éditeur déjà ouvert à l'activation : son gestionnaire est en place, on
	// le remplace par le nôtre.
	adopt(inst) {
		let win = inst._iframeWindow;
		let orig = inst._messageHandler;
		if (!win || typeof orig !== "function" || orig.__annota) return;
		let wrapped = this.wrapHandler(inst);
		if (!wrapped) return;
		win.removeEventListener("message", orig);
		win.addEventListener("message", wrapped);
		this.watchPopups(inst);
	},

	release(inst) {
		this.unwatchPopups(inst);
		let w = inst._messageHandler;
		if (typeof w !== "function" || !w.__annota) return;
		inst._messageHandler = w.__orig;
		let win = inst._iframeWindow;
		if (win) {
			win.removeEventListener("message", w);
			win.addEventListener("message", w.__orig);
		}
	},

	// Vrai si le message est pris en charge ici. L'ouverture est asynchrone :
	// si aucun surlignage n'est identifié, on rend la main à Zotero.
	intercept(inst, e, orig) {
		if (!e || e.source !== inst._iframeWindow || !e.data
			|| e.data.instanceID !== inst.instanceID) {
			return false;
		}
		let msg = e.data.message || {};
		if (msg.action === "initialized") {
			this.watchPopups(inst);
			return false;
		}
		if (msg.action === "insertObject" && msg.type === "zotero/annotation") {
			return this.interceptDrop(inst, e, orig, msg);
		}
		if (msg.action !== "openCitationPage" || !msg.citation) return false;
		this.openCitation(msg.citation).then(done => {
			if (!done) orig(e);
		}, err => {
			log("citations : ouverture du surlignage : " + err);
			orig(e);
		});
		return true;
	},

	// ---- 6. Dépôt d'un surlignage dans le texte d'une note ----
	//
	// Avec le gabarit « {{citation}} », Zotero insère un paragraphe : la
	// citation part à la ligne. Un surlignage déposé seul dans un paragraphe
	// non vide y est inséré dans la ligne ; déposé juste après le point final
	// d'une phrase, il se place avant ce point, espace compris :
	// « …composantes (Milliken, 1987, p. 136). ». Plusieurs surlignages, une
	// ligne vide ou un autre gabarit gardent le comportement de Zotero.

	interceptDrop(inst, e, orig, msg) {
		let anns = null;
		try { anns = JSON.parse(msg.data); }
		catch (err) { return false; }
		if (!Array.isArray(anns) || anns.length !== 1
			|| !["highlight", "underline"].includes(anns[0] && anns[0].type)) {
			return false;
		}
		if (inst._readOnly) return true;
		(async () => {
			await inst._ensureNoteCreated();
			let { html } = Zotero.EditorInstanceUtilities.serializeAnnotations(anns);
			if (!html) return;
			let plan = null;
			try { plan = this.inlinePlan(this.editorView(inst), msg.pos, html); }
			catch (err) { log("citations : dépôt dans la ligne : " + err); }
			if (!plan) {
				inst._postMessage({ action: "insertHTML", pos: msg.pos, html });
				return;
			}
			if (plan.spaces) {
				let view = this.editorView(inst);
				view.dispatch(view.state.tr.insertText(plan.spaces, plan.at));
			}
			inst._postMessage({ action: "insertHTML", pos: plan.pos, html: plan.html });
		})().catch(err => {
			log("citations : dépôt : " + err);
			orig(e);
		});
		return true;
	},

	// Vue ProseMirror de l'éditeur de notes (dans son cadre), ou null.
	editorView(inst) {
		try {
			let w = inst._iframeWindow && inst._iframeWindow.wrappedJSObject;
			let cur = w && w._currentEditorInstance;
			return (cur && cur._editorCore && cur._editorCore.view) || null;
		}
		catch (e) { return null; }
	},

	// Insertion dans la ligne : { html, pos, spaces, at }, ou null pour laisser
	// faire Zotero. La citation ne doit pas être accompagnée d'autre chose
	// (passage, commentaire) : sinon le paragraphe de Zotero reste de mise.
	inlinePlan(view, pos, html) {
		if (!view || !Number.isInteger(pos) || pos < 0) return null;
		let m = String(html).trim().match(/^<p>([\s\S]*)<\/p>$/i);
		if (!m || /<\/?(p|div|h\d|ul|ol|li|blockquote|table|pre)\b/i.test(m[1])) return null;
		let inner = m[1].trim();
		// Ce qui reste une fois les citations ôtées (spans imbriqués appariés).
		let rest = "", last = 0, found = 0, c;
		let open = /<span\b(?=[^>]*\bclass="citation")[^>]*>/g;
		while ((c = open.exec(inner)) !== null) {
			let end = this._endOfSpan(inner, c.index + c[0].length);
			if (end < 0) return null;
			rest += inner.slice(last, c.index);
			last = end;
			open.lastIndex = end;
			found++;
		}
		rest += inner.slice(last);
		if (!found || rest.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()) return null;

		let doc = view.state.doc;
		let $p = doc.resolve(Math.min(pos, doc.content.size));
		let block = $p.parent;
		if (!block || !block.isTextblock || !block.content.size) return null;
		let before = block.textBetween(0, $p.parentOffset, null, "\ufffc");
		let after = block.textBetween($p.parentOffset, block.content.size, null, "\ufffc");
		let at = pos;
		// Juste après le point final : la citation passe avant lui.
		let dot = before.match(/(^|[^.])\.(\s*)$/);
		if (dot) {
			at = pos - 1 - dot[2].length;
			before = before.slice(0, before.length - 1 - dot[2].length);
			after = "." + after;
		}
		let lead = before && !/\s$/.test(before) ? " " : "";
		let trail = after && /^[\p{L}\p{N}(«“]/u.test(after) ? " " : "";
		return { html: inner, at, spaces: lead + trail, pos: at + lead.length };
	},

	async openCitation(citation) {
		let ci = citation && citation.citationItems && citation.citationItems[0];
		if (!ci) return false;
		let ann = await this.annotationFor(ci);
		if (!ann) return false;
		await this.showAnnotation(ann);
		return true;
	},

	isAnnotation(item) {
		return !!item && typeof item.isAnnotation === "function" && item.isAnnotation();
	},

	// Surlignage désigné par une citation, ou null.
	async annotationFor(ci) {
		if (!ci) return null;
		if (ci.annotationURI) {
			try {
				let it = await Zotero.URI.getURIItem(String(ci.annotationURI));
				if (this.isAnnotation(it)) return it;
			}
			catch (e) { /* surlignage supprimé ou bibliothèque absente */ }
		}
		let source = null;
		try { source = await Zotero.EditorInstance.getItemFromURIs(ci.uris || []); }
		catch (e) { return null; }
		if (!source) return null;

		if (ci.annotationKey) {
			let it = Zotero.Items.getByLibraryAndKey(source.libraryID, String(ci.annotationKey));
			if (this.isAnnotation(it)) return it;
		}

		// Citation antérieure, sans clé : le surlignage de cette page, s'il
		// est seul. Plusieurs candidats : on ne devine pas.
		if (!ci.locator) return null;
		let page = String(ci.locator).trim();
		let atts = [];
		if (source.isRegularItem && source.isRegularItem()) {
			atts = source.getAttachments().map(id => Zotero.Items.get(id)).filter(Boolean);
		}
		else if (source.isAttachment && source.isAttachment()) {
			atts = [source];
		}
		let found = [];
		for (let att of atts) {
			if (typeof att.getAnnotations !== "function") continue;
			for (let a of att.getAnnotations()) {
				if (!["highlight", "underline"].includes(a.annotationType)) continue;
				if (String(a.annotationPageLabel || "").trim() === page) found.push(a);
			}
		}
		return found.length === 1 ? found[0] : null;
	},

	_delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	async _waitFor(test, timeout) {
		let end = Date.now() + timeout;
		for (;;) {
			let v = null;
			try { v = test(); }
			catch (e) { v = null; }
			if (v) return v;
			if (Date.now() > end) return null;
			await this._delay(100);
		}
	},

	readerFor(attachmentID) {
		let readers = (Zotero.Reader && Zotero.Reader._readers) || [];
		return readers.find(r => r && r.itemID === attachmentID && !r._isTabClosed) || null;
	},

	// Ouvre le document sur le surlignage et le sélectionne : encadré dans la
	// page, mis en avant dans le panneau des annotations, comme après un clic.
	async showAnnotation(ann) {
		let att = ann.parentItem;
		if (!att) return;
		let location = { annotationID: ann.key };
		let reader = await Zotero.Reader.open(att.id, location);
		// Onglet présent mais déchargé : Zotero le recharge sans rendre le lecteur.
		reader = reader || await this._waitFor(() => this.readerFor(att.id), 10000);
		if (!reader) return;
		try { await reader._initPromise; }
		catch (e) { return; }
		let ir = reader._internalReader;
		if (!ir) return;

		// Les annotations arrivent après l'ouverture : attendre la nôtre. Le
		// tableau appartient au lecteur, on le parcourt sans lui passer de
		// fonction.
		let loaded = await this._waitFor(() => {
			let list = ir._state && ir._state.annotations;
			if (!list) return false;
			for (let i = 0; i < list.length; i++) {
				if (list[i] && list[i].id === ann.key) return true;
			}
			return false;
		}, 8000);
		if (!loaded) return;

		try {
			ir.toggleSidebar(true);
			if (typeof reader._onToggleSidebarCallback === "function") {
				reader._onToggleSidebarCallback(true);
			}
			ir.setSidebarView("annotations");
			ir.setSelectedAnnotations(
				Components.utils.cloneInto([ann.key], reader._iframeWindow), false);
		}
		catch (e) {
			log("citations : sélection du surlignage : " + e);
			try { reader.navigate(location); }
			catch (e2) { /* lecteur fermé entre-temps */ }
		}
	},

	// ---- 3. Bouton « Ouvrir l'annotation » ----

	watchPopups(inst) {
		this.unwatchPopups(inst);
		let win = inst._iframeWindow;
		let doc = win && win.document;
		if (!doc || !doc.body || typeof win.MutationObserver !== "function") return;
		let pending = false;
		let obs = new win.MutationObserver(() => {
			if (pending) return;
			pending = true;
			win.requestAnimationFrame(() => {
				pending = false;
				try { this.decoratePopup(inst); }
				catch (e) { log("citations : menu de la citation : " + e); }
			});
		});
		obs.observe(doc.body, { childList: true, subtree: true });
		inst._annotaPopupObserver = obs;
	},

	unwatchPopups(inst) {
		if (inst._annotaPopupObserver) {
			try { inst._annotaPopupObserver.disconnect(); }
			catch (e) { /* fenêtre fermée */ }
		}
		inst._annotaPopupObserver = null;
		try {
			let doc = inst._iframeWindow && inst._iframeWindow.document;
			if (doc) for (let b of doc.querySelectorAll(".annota-open-annotation")) b.remove();
		}
		catch (e) { /* fenêtre fermée */ }
	},

	// Citation sélectionnée dans la note (celle dont le menu est ouvert).
	selectedCitation(doc) {
		let el = doc.querySelector(".citation.ProseMirror-selectednode")
			|| doc.querySelector(".ProseMirror-selectednode .citation");
		let raw = el && el.getAttribute("data-citation");
		if (!raw) return null;
		try { return JSON.parse(decodeURIComponent(raw)); }
		catch (e) { return null; }
	},

	decoratePopup(inst) {
		let doc = inst._iframeWindow && inst._iframeWindow.document;
		let popup = doc && doc.querySelector(".citation-popup");
		if (!popup || popup.querySelector(".annota-open-annotation") || popup._annotaPending) return;
		let citation = this.selectedCitation(doc);
		let ci = citation && citation.citationItems && citation.citationItems[0];
		if (!ci) return;
		popup._annotaPending = true;
		this.annotationFor(ci).then(ann => {
			popup._annotaPending = false;
			// Menu refermé, ou citation changée pendant la recherche.
			if (!ann || !popup.isConnected || popup.querySelector(".annota-open-annotation")) return;
			let now = this.selectedCitation(doc);
			let nci = now && now.citationItems && now.citationItems[0];
			if (!nci || JSON.stringify(nci.uris) !== JSON.stringify(ci.uris)
				|| nci.locator !== ci.locator || nci.annotationKey !== ci.annotationKey) {
				return;
			}
			popup.appendChild(this.makeButton(doc, ann));
		}, () => { popup._annotaPending = false; });
	},

	makeButton(doc, ann) {
		let b = doc.createElement("button");
		b.className = "annota-open-annotation";
		b.type = "button";
		let icon = doc.createElement("div");
		icon.className = "icon";
		let NS = "http://www.w3.org/2000/svg";
		let svg = doc.createElementNS(NS, "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("fill", "none");
		// Marqueur de surlignage : un trait épais sous trois lignes de texte.
		let paths = [
			["M2 3h12", "1"], ["M2 6.5h12", "1"], ["M2 10.5h8", "3.5"]
		];
		for (let [d, w] of paths) {
			let p = doc.createElementNS(NS, "path");
			p.setAttribute("d", d);
			p.setAttribute("stroke", "currentColor");
			p.setAttribute("stroke-width", w);
			if (w !== "1") p.setAttribute("stroke-opacity", "0.55");
			svg.appendChild(p);
		}
		icon.appendChild(svg);
		let title = doc.createElement("div");
		title.className = "title";
		title.textContent = this.t("cite.open");
		b.appendChild(icon);
		b.appendChild(title);
		b.addEventListener("mousedown", e => e.preventDefault());
		b.addEventListener("click", e => {
			e.preventDefault();
			e.stopPropagation();
			this.showAnnotation(ann).catch(err => log("citations : " + err));
		});
		return b;
	},

	t(key, vars) {
		try { if (Annota && typeof Annota.t === "function") return Annota.t(key, vars); }
		catch (e) { /* textes indisponibles */ }
		return key === "cite.open" ? "Open annotation" : key;
	},

	// ---- 4. Notes déjà écrites : le surlignage réduit à sa citation ----
	//
	// Avec l'ancien gabarit, un surlignage glissé dans une note y déposait
	// « <span class="highlight" data-annotation=…>« passage »</span>
	// <span class="citation" …>(Auteur, 2015, p. 18)</span> commentaire ».
	// Le passage et le commentaire vivent déjà dans l'annotation : le trio
	// devient la seule citation, portant la clé du surlignage comme au dépôt
	// (annotationKey, annotationURI), pour « Aller à la page » et « Ouvrir
	// l'annotation ». Le texte qui suit la citation n'est retiré que s'il est
	// le commentaire du surlignage, ou une version antérieure que le
	// commentaire actuel contient : une phrase ajoutée à la main reste.
	// Un surlignage supprimé depuis n'est pas touché : son passage n'existe
	// plus que dans la note.

	_HL_OPEN: /<span\b(?=[^>]*\bclass="highlight")[^>]*\bdata-annotation="([^"]*)"[^>]*>/g,
	_CIT_OPEN: /^(?:\s|&nbsp;|\u00a0)*<span\b(?=[^>]*\bclass="citation")[^>]*>/,

	// Indice qui suit le </span> fermant le span ouvert juste avant « from ».
	_endOfSpan(html, from) {
		let re = /<span\b[^>]*>|<\/span>/g;
		re.lastIndex = from;
		let depth = 1, m;
		while ((m = re.exec(html)) !== null) {
			depth += m[0] === "</span>" ? -1 : 1;
			if (depth === 0) return m.index + m[0].length;
		}
		return -1;
	},

	// Texte réduit à ses mots : balises, entités, accents, casse et blancs
	// ne comptent pas (un commentaire a pu être reformaté ou corrigé).
	_plain(s) {
		return String(s || "")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;|&#160;/g, " ")
			.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'")
			.replace(/[*_]+/g, "")
			.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim();
	},

	// Texte lisible d'un fragment de note, pour l'aperçu.
	_display(s) {
		return String(s || "")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;|&#160;/g, " ")
			.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'")
			.replace(/\s+/g, " ")
			.trim();
	},

	// Surlignages glissés présents dans une note : [{ key, attachmentURI }].
	highlightsIn(html) {
		let out = [], m;
		let re = new RegExp(this._HL_OPEN.source, "g");
		while ((m = re.exec(String(html || ""))) !== null) {
			try {
				let a = JSON.parse(decodeURIComponent(m[1]));
				if (a && a.annotationKey) out.push({ key: String(a.annotationKey), attachmentURI: a.attachmentURI || "" });
			}
			catch (e) { /* attribut illisible */ }
		}
		return out;
	},

	// Réduit une note. info(clé) rend { comment, uri } pour un surlignage
	// existant, null sinon. Renvoie { html, count, kept, examples } ; kept :
	// les textes laissés après une citation, faute d'être le commentaire.
	reduceHTML(html, info) {
		html = String(html || "");
		let re = new RegExp(this._HL_OPEN.source, "g");
		let out = "", last = 0, count = 0, kept = [], examples = [], m;
		while ((m = re.exec(html)) !== null) {
			let hlEnd = this._endOfSpan(html, m.index + m[0].length);
			if (hlEnd < 0) continue;
			let key = null;
			try { key = JSON.parse(decodeURIComponent(m[1])).annotationKey || null; }
			catch (e) { key = null; }
			let ann = key ? info(String(key)) : null;
			let mc = ann ? html.slice(hlEnd).match(this._CIT_OPEN) : null;
			if (!mc) { re.lastIndex = hlEnd; continue; }
			let citStart = hlEnd + mc[0].length - mc[0].replace(/^(?:\s|&nbsp;|\u00a0)*/, "").length;
			let citEnd = this._endOfSpan(html, hlEnd + mc[0].length);
			if (citEnd < 0) { re.lastIndex = hlEnd; continue; }

			// Fin du paragraphe : la première balise fermante de bloc.
			let rest = html.slice(citEnd);
			let close = rest.search(/<\/(?:p|li|h[1-6]|div|blockquote|td)>/i);
			let parEnd = close < 0 ? html.length : citEnd + close;
			let tail = this._plain(html.slice(citEnd, parEnd));
			let comment = this._plain(ann.comment);
			let dropTail = !!comment && tail !== ""
				&& (tail === comment || (tail.length >= 12 && comment.includes(tail)));

			let citation = this._tagCitation(html.slice(citStart, citEnd), String(key), ann.uri);
			let end = dropTail ? parEnd : citEnd;
			if (tail && !dropTail) kept.push(this._display(html.slice(citEnd, parEnd)));
			if (examples.length < 3) {
				examples.push({ before: this._display(html.slice(m.index, end)), after: this._display(citation) });
			}
			out += html.slice(last, m.index) + citation;
			last = end;
			re.lastIndex = end;
			count++;
		}
		return { html: count ? out + html.slice(last) : html, count, kept, examples };
	},

	_tagCitation(span, key, uri) {
		return span.replace(/data-citation="([^"]*)"/, (m, enc) => {
			try {
				let c = JSON.parse(decodeURIComponent(enc));
				let ci = c && c.citationItems && c.citationItems[0];
				if (!ci) return m;
				ci.annotationKey = key;
				if (uri) ci.annotationURI = uri;
				return 'data-citation="' + encodeURIComponent(JSON.stringify(c)) + '"';
			}
			catch (e) {
				return m;
			}
		});
	},

	// Surlignages d'une note encore présents dans Zotero : clé -> { comment, uri }.
	async annotationsFor(html) {
		let map = new Map();
		for (let h of this.highlightsIn(html)) {
			if (map.has(h.key)) continue;
			let uri = String(h.attachmentURI || "").replace(/[^/]+$/, h.key);
			let it = null;
			try { it = uri ? await Zotero.URI.getURIItem(uri) : null; }
			catch (e) { it = null; }
			if (this.isAnnotation(it)) map.set(h.key, { comment: it.annotationComment || "", uri });
		}
		return map;
	},

	// Ce que la réduction changerait : [{ note, html, count, examples }].
	async plan(notes) {
		let out = [];
		for (let note of notes) {
			let html = note.getNote();
			if (!html || !html.includes('class="highlight"')) continue;
			let anns = await this.annotationsFor(html);
			if (!anns.size) continue;
			let r = this.reduceHTML(html, k => anns.get(k) || null);
			if (r.count) out.push({ note, html: r.html, before: html, count: r.count, examples: r.examples });
		}
		return out;
	},

	// Notes visées par la sélection : les notes elles-mêmes, et les notes
	// filles des documents sélectionnés.
	notesOfSelection(window) {
		let seen = new Set(), out = [];
		let add = n => { if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); } };
		for (let it of window.ZoteroPane.getSelectedItems() || []) {
			if (it.isNote && it.isNote()) add(it);
			else if (it.isRegularItem && it.isRegularItem()) {
				for (let id of it.getNotes()) add(Zotero.Items.get(id));
			}
		}
		return out;
	},

	async notesOfLibrary(libraryID) {
		let s = new Zotero.Search();
		s.libraryID = libraryID;
		s.addCondition("itemType", "is", "note");
		let ids = await s.search();
		return (await Zotero.Items.getAsync(ids)).filter(n => n && n.isNote && n.isNote());
	},

	// IOUtils et PathUtils : globaux dans Zotero ; à défaut, ceux de la fenêtre.
	_io() {
		let win = Zotero.getMainWindow && Zotero.getMainWindow();
		return {
			IO: typeof IOUtils !== "undefined" ? IOUtils : win.IOUtils,
			Path: typeof PathUtils !== "undefined" ? PathUtils : win.PathUtils
		};
	},

	_backupDir() {
		return this._io().Path.join(Zotero.DataDirectory.dir, "annota", "sauvegardes-notes");
	},

	// Montre ce qui changera, demande l'accord, garde les notes d'origine,
	// puis écrit.
	async reduce(window, notes) {
		let plan = await this.plan(notes);
		let ps = Services.prompt;
		if (!plan.length) {
			ps.alert(window, "Annota", this.t("reduce.none"));
			return;
		}
		let hl = plan.reduce((n, p) => n + p.count, 0);
		let ex = plan[0].examples[0];
		let cut = s => s.length > 220 ? s.slice(0, 217) + "…" : s;
		let msg = this.t("reduce.confirm", { notes: plan.length, highlights: hl })
			+ "\n\n" + this.t("reduce.before") + "\n" + cut(ex.before)
			+ "\n\n" + this.t("reduce.after") + "\n" + cut(ex.after)
			+ "\n\n" + this.t("reduce.backup");
		if (!ps.confirm(window, "Annota", msg)) return;

		let { IO, Path } = this._io();
		let dir = this._backupDir();
		await IO.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let file = Path.join(dir, "reduction-" + stamp + ".json");
		await IO.writeUTF8(file, JSON.stringify({
			date: new Date().toISOString(),
			notes: plan.map(p => ({ libraryID: p.note.libraryID, key: p.note.key, before: p.before, after: p.html }))
		}));

		let done = 0;
		for (let p of plan) {
			try {
				p.note.setNote(p.html);
				await p.note.saveTx();
				done++;
			}
			catch (e) {
				log("réduction de la note " + p.note.key + " : " + e);
			}
		}
		toast("Annota", this.t("reduce.done", { notes: done, highlights: hl }));
	},

	// Rétablit les notes de la dernière réduction, sauf celles modifiées depuis.
	async undoLast(window) {
		let ps = Services.prompt;
		let { IO } = this._io();
		let dir = this._backupDir();
		let files = [];
		try { files = (await IO.getChildren(dir)).filter(f => /reduction-.*\.json$/.test(f)).sort(); }
		catch (e) { files = []; }
		if (!files.length) {
			ps.alert(window, "Annota", this.t("reduce.noundo"));
			return;
		}
		let file = files[files.length - 1];
		let data = JSON.parse(await IO.readUTF8(file));
		if (!ps.confirm(window, "Annota", this.t("reduce.undoconfirm", { notes: data.notes.length, date: data.date }))) return;
		let restored = 0, skipped = 0;
		for (let n of data.notes) {
			let note = await Zotero.Items.getByLibraryAndKeyAsync(n.libraryID, n.key);
			if (!note || note.getNote() !== n.after) { skipped++; continue; }
			note.setNote(n.before);
			await note.saveTx();
			restored++;
		}
		await IO.move(file, file.replace(/\.json$/, ".annulee.json"));
		ps.alert(window, "Annota", this.t("reduce.undone", { restored, skipped }));
	}
};
