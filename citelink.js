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
		if (msg.action !== "openCitationPage" || !msg.citation) return false;
		this.openCitation(msg.citation).then(done => {
			if (!done) orig(e);
		}, err => {
			log("citations : ouverture du surlignage : " + err);
			orig(e);
		});
		return true;
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

	t(key) {
		try { if (Annota && typeof Annota.t === "function") return Annota.t(key); }
		catch (e) { /* textes indisponibles */ }
		return key === "cite.open" ? "Open annotation" : key;
	}
};
