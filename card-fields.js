/* eslint-disable no-undef */
// Annota — champs de la couleur dans la carte d'annotation de la barre
// latérale du lecteur, à la place du champ unique « Ajouter un commentaire ».
//
// Accroche : l'en-tête de la carte (point d'extension officiel
// « renderSidebarAnnotationHeader » du lecteur). Depuis l'élément accroché,
// on remonte à la carte (.preview) et l'on place le formulaire après le
// passage (.text), en masquant le commentaire natif (.comment), que Zotero
// n'affiche que si la carte est sélectionnée ou commentée : le formulaire
// suit la même règle. Un MutationObserver remet les choses en place quand le
// lecteur redessine la carte sans rappeler l'accroche (changement de
// sélection).
//
// Les valeurs des champs ne se déduisent pas toujours du commentaire (un
// champ vide disparaît de la mise en page). Annota les mémorise donc pour
// chaque annotation qu'il écrit (annota-fields.json, dossier de données de
// Zotero) ; pour un commentaire plus ancien, elles sont relues ligne par
// ligne d'après le format de chaque champ. Un commentaire qui ne s'y prête
// pas (écrit à la main, mise en page personnalisée inconnue) garde le champ
// natif de Zotero : rien n'est réécrit sans être compris.

var AnnotaCardFields = {
	_listener: null,
	_store: null,
	_loading: null,
	_saveTimer: null,

	// ---- Mémoire des valeurs ----

	file() {
		let dir;
		try { dir = Zotero.DataDirectory.dir; } catch (e) {}
		if (!dir) dir = Zotero.getTempDirectory().path;
		return PathUtils.join(dir, "annota-fields.json");
	},

	load() {
		if (this._store) return Promise.resolve(this._store);
		if (this._loading) return this._loading;
		this._loading = (async () => {
			let data = {};
			try {
				if (await IOUtils.exists(this.file())) {
					let j = await IOUtils.readJSON(this.file());
					if (j && j.annotations && typeof j.annotations === "object") data = j.annotations;
				}
			}
			catch (e) { log("champs de carte : mémoire illisible, ignorée : " + e); }
			this._store = data;
			return data;
		})();
		return this._loading;
	},

	persist() {
		if (this._saveTimer) clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			IOUtils.writeJSON(this.file(), { version: 1, annotations: this._store || {} },
				{ tmpPath: this.file() + ".tmp" }).catch(e => log("champs de carte : " + e));
		}, 1000);
	},

	keyOf(libraryID, key) {
		return libraryID + "/" + key;
	},

	// Appelé après chaque écriture d'un commentaire par Annota.
	remember(item, values, references, comment) {
		if (!item || !values) return;
		this.load().then(store => {
			store[this.keyOf(item.libraryID, item.key)] = {
				color: item.annotationColor, values, references: references || "", comment: comment || ""
			};
			this.persist();
		}).catch(e => log("champs de carte : " + e));
	},

	// ---- Valeurs d'une annotation ----

	// Valeur brute d'une ligne de mise en page par défaut, selon le format.
	unwrap(line, format) {
		let patterns = {
			bold: /^<b>([\s\S]*)<\/b>$/,
			italic: /^<i>([\s\S]*)<\/i>$/,
			bolditalic: /^<b><i>([\s\S]*)<\/i><\/b>$/,
			underline: /^<u>([\s\S]*)<\/u>$/
		};
		if (patterns[format]) {
			let m = line.match(patterns[format]);
			return m ? m[1] : null;
		}
		// Format « plain » : une ligne qui n'est pas entièrement enveloppée.
		return /^<(b|i|u)>[\s\S]*<\/\1>$/.test(line) ? null : line;
	},

	// Relit un commentaire écrit avec la mise en page par défaut (une ligne
	// par champ non vide, dans l'ordre). null si les lignes ne s'y prêtent pas.
	parse(schema, comment) {
		let lines = String(comment || "").split("\n").map(l => l.trim()).filter(Boolean);
		let values = {};
		for (let f of schema) values[f.name] = "";
		let j = 0;
		for (let line of lines) {
			let found = false;
			for (; j < schema.length; j++) {
				let v = this.unwrap(line, schema[j].format);
				if (v !== null) {
					values[schema[j].name] = schema[j].type === "check"
						? (/^(true|yes|oui|1|x|✓)$/i.test(v) ? "true" : "") : v;
					j++;
					found = true;
					break;
				}
			}
			if (!found) return null;
		}
		return values;
	},

	// { values, references } ou null (commentaire non structuré).
	resolve(entry, schema, libraryID, annotation) {
		let comment = String(annotation.comment || "");
		let mem = this._store && this._store[this.keyOf(libraryID, annotation.id)];
		if (mem && mem.comment === comment && mem.color === annotation.color) {
			return { values: Object.assign({}, mem.values), references: mem.references || "" };
		}
		if (!comment.trim()) {
			let values = {};
			for (let f of schema) values[f.name] = "";
			return { values, references: "" };
		}
		// Mise en page personnalisée : on ne devine pas.
		if (String(entry.template || "").trim()) return null;
		let values = this.parse(schema, comment);
		return values ? { values, references: "" } : null;
	},

	// La carte s'applique-t-elle à cette couleur ? Il faut des champs à
	// saisir, et un commentaire construit à partir d'eux (pas de {{ai}}).
	entryFor(color) {
		let entry = Annota.getColorEntry(color);
		if (!entry || Annota.entryNeedsAI(entry)) return null;
		let schema = Annota.parseFieldSchema(entry.fields);
		if (!schema.some(f => f.type !== "ai")) return null;
		return { entry, schema };
	},

	// ---- Accroche ----

	register() {
		if (!Zotero.Reader || !Zotero.Reader.registerEventListener) return;
		this.load().catch(() => {});
		this._listener = (event) => {
			try { this.onHeader(event); }
			catch (e) { log("champs de carte : " + e); }
		};
		Zotero.Reader.registerEventListener("renderSidebarAnnotationHeader",
			this._listener, "annota@equiriconi");
	},

	unregister() {
		try {
			if (this._listener && Zotero.Reader && Zotero.Reader.unregisterEventListener) {
				Zotero.Reader.unregisterEventListener("renderSidebarAnnotationHeader", this._listener);
			}
		}
		catch (e) {}
		this._listener = null;
		// Cartes déjà transformées : on rend le champ natif.
		for (let r of (Zotero.Reader && Zotero.Reader._readers) || []) {
			try {
				let doc = r._iframeWindow && r._iframeWindow.document;
				if (!doc) continue;
				for (let form of doc.querySelectorAll(".annota-card-form")) {
					let card = form.closest(".preview");
					if (card && card._annotaObserver) card._annotaObserver.disconnect();
					let native = card && card.querySelector(":scope > .comment");
					if (native) native.style.removeProperty("display");
					form.remove();
				}
			}
			catch (e) {}
		}
	},

	onHeader({ reader, doc, params, append }) {
		if (getPref("cardFields", true) === false) return;
		let annotation = params && params.annotation;
		if (!annotation || !reader || !doc || !append) return;
		if (!["highlight", "underline"].includes(annotation.type)) return;
		// Marqueur invisible : il situe la carte dans le document.
		let mark = doc.createElement("span");
		mark.className = "annota-card-hook";
		mark.style.display = "none";
		append(mark);
		let card = mark.closest(".preview");
		if (!card) return;
		card._annotaCtx = { reader, annotation };
		if (!card._annotaObserver) {
			let obs = new doc.defaultView.MutationObserver(() => {
				if (card._annotaBusy) return;
				this.ensure(card).catch(e => log("champs de carte : " + e));
			});
			obs.observe(card, { childList: true });
			card._annotaObserver = obs;
		}
		this.ensure(card).catch(e => log("champs de carte : " + e));
	},

	// Place, met à jour ou retire le formulaire de la carte.
	async ensure(card) {
		let { reader, annotation } = card._annotaCtx || {};
		if (!annotation) return;
		let doc = card.ownerDocument;
		let form = card.querySelector(":scope > .annota-card-form");
		let native = card.querySelector(":scope > .comment");
		let cfg = this.entryFor(annotation.color);
		let att = Zotero.Items.get(reader.itemID);
		if (!this._store) await this.load();
		let resolved = cfg && att ? this.resolve(cfg.entry, cfg.schema, att.libraryID, annotation) : null;

		// Zotero n'affiche le commentaire que pour une carte sélectionnée ou
		// commentée : sans lui, pas de formulaire non plus.
		if (!cfg || !resolved || !native || annotation.readOnly) {
			card._annotaBusy = true;
			if (form) form.remove();
			if (native) native.style.removeProperty("display");
			card._annotaBusy = false;
			return;
		}

		card._annotaBusy = true;
		try {
			if (!form || form._annotaColor !== annotation.color) {
				if (form) form.remove();
				form = this.build(doc, card, cfg);
				form._annotaColor = annotation.color;
			}
			// Toujours juste avant le commentaire natif, qui reste masqué.
			if (form.nextSibling !== native) card.insertBefore(form, native);
			native.style.display = "none";
			// Pas de réécriture sous les doigts : un champ en cours de saisie
			// garde ce qui y est tapé.
			if (!form.contains(doc.activeElement) && !form._dirty) this.fill(form, resolved);
			form._annotaRefs = resolved.references;
		}
		finally {
			card._annotaBusy = false;
		}
	},

	// ---- Formulaire ----

	// La marge est imposée (!important) : la règle qui neutralise .label-popup
	// (Annota._ensureFormStyles) remet sinon padding et margin à zéro.
	CSS: ".annota-card-form{display:flex;flex-direction:column;gap:6px;"
		+ "box-sizing:border-box;width:100%;}"
		+ ".annota-fields.annota-card-form{padding:4px 10px 8px !important;}"
		+ ".annota-card-form .annota-card-label{font-size:11px;opacity:.6;margin-bottom:1px;}"
		+ ".annota-card-form .annota-card-input{width:100%;max-width:100%;box-sizing:border-box;"
		+ "font:inherit;font-size:12px;line-height:1.35;padding:3px 6px;margin:0;color:inherit;"
		+ "border:1px solid rgba(128,128,128,.35);border-radius:4px;background:rgba(128,128,128,.08);"
		+ "outline:none;resize:none;overflow:hidden;}"
		+ ".annota-card-form .annota-card-input:focus{border-color:rgba(128,128,128,.7);"
		+ "background:transparent;}"
		+ ".annota-card-form .annota-card-check{display:flex;align-items:center;gap:6px;font-size:12px;}"
		+ ".annota-card-form .annota-card-ai{font-size:12px;line-height:1.35;opacity:.75;}"
		+ ".annota-card-form .annota-card-foot{display:flex;align-items:center;justify-content:space-between;"
		+ "gap:6px;min-height:16px;}"
		+ ".annota-card-form .annota-card-status{font-size:10.5px;opacity:.55;}"
		+ ".annota-card-form .annota-card-fill{appearance:none;margin:0;padding:1px 8px;font:inherit;"
		+ "font-size:11px;color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:4px;"
		+ "background:transparent;cursor:pointer;}"
		+ ".annota-card-form .annota-card-fill:hover{background:rgba(128,128,128,.12);}"
		+ ".annota-card-form .annota-card-fill[disabled]{opacity:.5;cursor:default;}",

	injectStyle(doc) {
		Annota._ensureFormStyles(doc);
		if (doc.getElementById("annota-card-style")) return;
		let st = doc.createElement("style");
		st.id = "annota-card-style";
		st.textContent = this.CSS;
		(doc.head || doc.documentElement).appendChild(st);
	},

	build(doc, card, cfg) {
		this.injectStyle(doc);
		let form = doc.createElement("div");
		// label-popup : le lecteur n'efface pas l'annotation sélectionnée quand
		// on corrige un champ avec Suppr (voir Annota.FORM_CLASS).
		form.className = Annota.FORM_CLASS + " annota-card-form";
		form._fields = {};
		form._schema = cfg.schema;

		// La carte réagit aux clics (sélection) et au glisser : le formulaire
		// garde les siens pour lui, mais laisse la carte se sélectionner.
		for (let type of ["keydown", "keypress", "keyup"]) {
			form.addEventListener(type, e => e.stopPropagation());
		}
		form.addEventListener("dragstart", e => { e.stopPropagation(); e.preventDefault(); });
		form.addEventListener("dblclick", e => e.stopPropagation());

		for (let f of cfg.schema) {
			if (f.type === "ai") {
				let p = doc.createElement("div");
				p.className = "annota-card-ai";
				p.title = f.label;
				form.appendChild(p);
				form._fields[f.name] = { f, el: p, ai: true };
				continue;
			}
			let row = doc.createElement("div");
			let el;
			if (f.type === "check") {
				row.className = "annota-card-check";
				el = doc.createElement("input");
				el.type = "checkbox";
				el.style.margin = "0";
				let lab = doc.createElement("span");
				lab.textContent = f.label;
				row.appendChild(el);
				row.appendChild(lab);
			}
			else {
				let lab = doc.createElement("div");
				lab.className = "annota-card-label";
				lab.textContent = f.label;
				row.appendChild(lab);
				if (f.type === "select") {
					el = doc.createElement("select");
					for (let o of [""].concat(f.options)) {
						let opt = doc.createElement("option");
						opt.value = o;
						opt.textContent = o || "—";
						el.appendChild(opt);
					}
				}
				else {
					// Zone de texte pour tous : elle s'agrandit avec le contenu et
					// passe à la ligne, ce que la barre latérale étroite exige.
					el = doc.createElement("textarea");
					el.rows = 1;
					el.addEventListener("input", () => this.grow(el));
					if (f.type === "text") {
						el.addEventListener("keydown", e => { if (e.key === "Enter") e.preventDefault(); });
					}
				}
				el.className = "annota-card-input";
				row.appendChild(el);
			}
			// « content » : la liste des annotations ne vole pas les flèches.
			el.classList.add("content");
			Annota._shieldFromReaderShortcuts(el, f.type === "text" ? "textarea" : f.type);
			el.setAttribute("aria-label", f.label);
			let onEdit = () => {
				form._dirty = true;
				this.schedule(card, form, 700);
			};
			el.addEventListener("input", onEdit);
			el.addEventListener("change", onEdit);
			el.addEventListener("blur", () => { if (form._dirty) this.schedule(card, form, 0); });
			form._fields[f.name] = { f, el };
			form.appendChild(row);
		}

		let foot = doc.createElement("div");
		foot.className = "annota-card-foot";
		let status = doc.createElement("span");
		status.className = "annota-card-status";
		foot.appendChild(status);
		form._status = status;
		if (String(cfg.entry.prompt || "").trim()) {
			let fill = doc.createElement("button");
			fill.type = "button";
			fill.className = "annota-card-fill";
			fill.textContent = Annota.t("card.fill");
			fill.title = Annota.t("card.fill.title");
			fill.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.fillWithAI(card, form, fill).catch(err => log("champs de carte : " + err));
			});
			foot.appendChild(fill);
		}
		form.appendChild(foot);
		return form;
	},

	grow(el) {
		if (el.tagName !== "TEXTAREA") return;
		el.style.height = "auto";
		el.style.height = el.scrollHeight + "px";
	},

	// Valeur d'un champ pour la saisie : sans balises ni entités.
	plain(raw) {
		return String(raw || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
			.replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
	},

	fill(form, resolved) {
		form._raw = Object.assign({}, resolved.values);
		for (let name of Object.keys(form._fields)) {
			let { f, el, ai } = form._fields[name];
			let v = resolved.values[name] || "";
			if (ai) {
				el.textContent = this.plain(v);
				el.style.display = v ? "" : "none";
				continue;
			}
			if (f.type === "check") el.checked = !!v;
			else {
				el.value = this.plain(v);
				this.grow(el);
			}
		}
	},

	// Valeurs du formulaire. Un champ non modifié garde sa valeur d'origine,
	// mise en forme intérieure comprise (« plain » en a ôté les balises).
	read(form) {
		let values = {};
		for (let name of Object.keys(form._fields)) {
			let { f, el, ai } = form._fields[name];
			let raw = (form._raw && form._raw[name]) || "";
			if (ai) { values[name] = raw; continue; }
			let v = f.type === "check" ? (el.checked ? "true" : "") : String(el.value || "").trim();
			values[name] = (f.type !== "check" && v === this.plain(raw).trim()) ? raw : v;
		}
		return values;
	},

	schedule(card, form, delay) {
		let w = card.ownerDocument.defaultView;
		if (form._timer) w.clearTimeout(form._timer);
		form._timer = w.setTimeout(() => {
			form._timer = null;
			this.save(card, form).catch(e => {
				log("champs de carte : " + e);
				form._status.textContent = Annota.t("card.error");
			});
		}, delay);
	},

	async item(card) {
		let { reader, annotation } = card._annotaCtx;
		let att = await Zotero.Items.getAsync(reader.itemID);
		if (!att) return null;
		return Zotero.Items.getByLibraryAndKeyAsync(att.libraryID, annotation.id);
	},

	// Commentaire recomposé selon la mise en page de la couleur.
	compose(item, form, values) {
		let entry = Annota.getColorEntry(item.annotationColor);
		let ctx = Annota.getContext(item);
		ctx.references = form._annotaRefs || "";
		let vars = Annota.buildVars({ text: (item.annotationText || "").trim(), ctx,
			comment: "", fields: values });
		vars.ai = "";
		return Annota.renderTemplate(Annota.effectiveTemplate(entry), vars);
	},

	async save(card, form) {
		let item = await this.item(card);
		if (!item) return;
		let values = this.read(form);
		let comment = this.compose(item, form, values);
		form._dirty = false;
		if (comment === String(item.annotationComment || "")) return;
		item.annotationComment = comment;
		Annota.setFailedTag(item, false);
		await item.saveTx();
		form._raw = Object.assign({}, values);
		this.remember(item, values, form._annotaRefs, comment);
		form._status.textContent = Annota.t("card.saved");
		card.ownerDocument.defaultView.setTimeout(() => { form._status.textContent = ""; }, 1500);
	},

	// Le modèle remplit les champs restés vides, comme à la création ; ce qui
	// est tapé n'est jamais réécrit.
	async fillWithAI(card, form, button) {
		let notReady = Annota.providerReadyError();
		if (notReady) {
			toast("Annota", notReady, "error");
			return;
		}
		if (form._timer) {
			card.ownerDocument.defaultView.clearTimeout(form._timer);
			form._timer = null;
		}
		let item = await this.item(card);
		if (!item) return;
		button.disabled = true;
		form._status.textContent = Annota.t("card.filling");
		try {
			let text = (item.annotationText || "").trim();
			let values = this.read(form);
			let built = {};
			let comment = await Annota.buildComment({
				text, ctx: Annota.getContext(item), color: item.annotationColor,
				comment: "", fields: values,
				getRefs: () => Annota.getReferences(item, text), out: built
			});
			if (comment === null) return;
			item.annotationComment = comment;
			Annota.setFailedTag(item, false);
			await item.saveTx();
			let filled = built.values || values;
			form._annotaRefs = built.refs || form._annotaRefs || "";
			form._dirty = false;
			this.fill(form, { values: filled });
			this.remember(item, filled, form._annotaRefs, comment);
			form._status.textContent = Annota.t("card.saved");
		}
		catch (e) {
			form._status.textContent = Annota.t("card.error");
			toast("Annota", Annota.t("gen.failed", { msg: e.message || e }), "error");
		}
		finally {
			button.disabled = false;
		}
	}
};
