/* eslint-disable no-undef */
// Annota : deux outils sur les annotations d'une couleur choisie.
//
//  1. Le défilé (review) : les annotations dont aucun champ n'est rempli
//     passent une à une, comme des cartes. Pour chacune : le passage, sa
//     source, ses champs, « Remplir avec l'IA », « Ouvrir dans le document »,
//     puis « Enregistrer et suivante » ou « Passer ». Un compteur suit la
//     progression.
//  2. La relance (refill) : sur les références sélectionnées, l'IA remplit
//     de nouveau les champs cochés d'une couleur, les autres restant tels
//     quels. Les commentaires d'avant sont sauvegardés ; une commande les
//     rétablit.
//
// Les valeurs des champs sont lues et le commentaire recomposé comme dans la
// carte d'annotation du lecteur (card-fields.js) : même format, même mémoire.
// L'interface est une fenêtre superposée à la fenêtre principale de Zotero.
// Chargé par bootstrap.js : Annota, AnnotaCardFields, AnnotaCiteLink, getPref,
// log et toast y sont visibles.

var AnnotaReview = {
	HTML_NS: "http://www.w3.org/1999/xhtml",
	TYPES: ["highlight", "underline", "image"],

	// ---- Annotations visées ----

	// Annotations des éléments sélectionnés (références, pièces jointes,
	// annotations), ou de toute la bibliothèque si rien n'est sélectionné.
	async annotationsOf(window, wholeLibrary) {
		let out = [], seen = new Set();
		let addAtt = att => {
			if (!att || typeof att.getAnnotations !== "function") return;
			for (let a of att.getAnnotations()) {
				if (!seen.has(a.id) && this.TYPES.includes(a.annotationType)) { seen.add(a.id); out.push(a); }
			}
		};
		if (wholeLibrary) {
			let s = new Zotero.Search();
			s.libraryID = window.ZoteroPane.getSelectedLibraryID();
			s.addCondition("itemType", "is", "attachment");
			for (let att of await Zotero.Items.getAsync(await s.search())) addAtt(att);
			return out;
		}
		for (let it of window.ZoteroPane.getSelectedItems() || []) {
			if (it.isAnnotation && it.isAnnotation()) {
				if (!seen.has(it.id) && this.TYPES.includes(it.annotationType)) { seen.add(it.id); out.push(it); }
			}
			else if (it.isAttachment && it.isAttachment()) addAtt(it);
			else if (it.isRegularItem && it.isRegularItem()) {
				for (let id of it.getAttachments()) addAtt(Zotero.Items.get(id));
			}
		}
		return out;
	},

	// Couleurs dotées de champs, avec leurs annotations : [{ key, hex, label,
	// cfg, anns }], dans l'ordre de la palette.
	groups(anns) {
		let byKey = new Map();
		for (let a of anns) {
			let key = Annota.keyForItem(a);
			if (!byKey.has(key)) {
				let cfg = AnnotaCardFields.entryFor(key);
				byKey.set(key, cfg ? { key, cfg, anns: [] } : null);
			}
			let g = byKey.get(key);
			if (g) g.anns.push(a);
		}
		let order = Annota.COLORS.map(c => c.hex);
		let out = [];
		for (let g of byKey.values()) {
			if (!g) continue;
			let hex = String(g.key).replace(/^image:/, "");
			let pal = Annota.COLORS.find(c => c.hex === hex);
			g.hex = hex;
			g.image = /^image:/.test(g.key);
			g.label = g.cfg.entry.label || (pal ? pal.name : hex);
			out.push(g);
		}
		out.sort((a, b) => (order.indexOf(a.hex) - order.indexOf(b.hex)) || (a.image - b.image));
		return out;
	},

	// Valeurs des champs d'une annotation, ou null si son commentaire n'est
	// pas dans le format des champs (on n'y touche pas).
	valuesOf(ann, cfg) {
		let r = AnnotaCardFields.resolve(cfg.entry, cfg.schema, ann.libraryID,
			{ id: ann.key, comment: ann.annotationComment || "", color: ann.annotationColor });
		return r;
	},

	isEmpty(ann, cfg) {
		if (!String(ann.annotationComment || "").trim()) return true;
		let r = this.valuesOf(ann, cfg);
		return !!r && cfg.schema.every(f => !String(r.values[f.name] || "").trim());
	},

	// Ordre de lecture : par source, puis par position dans le document.
	sortForReading(anns) {
		return anns.slice().sort((a, b) => (a.parentItemID - b.parentItemID)
			|| String(a.annotationSortIndex || "").localeCompare(String(b.annotationSortIndex || "")));
	},

	async passage(ann) {
		if (ann.annotationType === "image") {
			try { return await Annota.areaText(ann); }
			catch (e) { return ""; }
		}
		return String(ann.annotationText || "").trim();
	},

	sourceLine(ann) {
		let att = ann.parentItem;
		let top = att && att.parentItem ? att.parentItem : att;
		let title = "", year = "";
		try { title = top.getDisplayTitle(); } catch (e) {}
		try { year = (String(top.getField("date") || "").match(/\d{4}/) || [""])[0]; } catch (e) {}
		let authors = "";
		try {
			let cr = top.getCreators ? top.getCreators() : [];
			authors = cr.slice(0, 2).map(c => c.lastName || c.name).filter(Boolean).join(", ")
				+ (cr.length > 2 ? " et al." : "");
		}
		catch (e) {}
		let head = [authors, year].filter(Boolean).join(", ");
		return (head ? head + " · " : "") + title
			+ (ann.annotationPageLabel ? " · p. " + ann.annotationPageLabel : "");
	},

	// Enregistre les valeurs : commentaire recomposé selon la mise en page de
	// la couleur, comme la carte du lecteur.
	async save(ann, values, refs) {
		let comment = AnnotaCardFields.compose(ann, { _annotaRefs: refs || "" }, values);
		if (comment === String(ann.annotationComment || "")) return false;
		ann.annotationComment = comment;
		Annota.setFailedTag(ann, false);
		await ann.saveTx();
		AnnotaCardFields.remember(ann, values, refs || "", comment);
		return true;
	},

	// L'IA remplit les champs vides de « values » ; rend { values, refs }.
	async aiFill(ann, values) {
		let text = await this.passage(ann);
		let built = {};
		let comment = await Annota.buildComment({
			text, ctx: Annota.getContext(ann), color: Annota.keyForItem(ann),
			comment: "", fields: Object.assign({}, values),
			getRefs: () => Annota.getReferences(ann, text), out: built
		});
		if (comment === null) return null;
		return { values: built.values || values, refs: built.refs || "" };
	},

	// ---- Fenêtre superposée ----

	el(doc, tag, cls, text) {
		let e = doc.createElementNS(this.HTML_NS, tag);
		if (cls) e.setAttribute("class", cls);
		if (text != null) e.textContent = text;
		return e;
	},

	button(doc, label, cls, fn, title) {
		let b = this.el(doc, "button", "annota-rv-btn" + (cls ? " " + cls : ""), label);
		b.setAttribute("type", "button");
		if (title) b.setAttribute("title", title);
		b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (!b.disabled) fn(); });
		return b;
	},

	open(window, title) {
		let doc = window.document;
		this.close(window);
		this.ensureStyles(doc);
		let back = this.el(doc, "div", "annota-rv-back");
		back.id = "annota-review";
		let card = this.el(doc, "div", "annota-rv-card");
		card.setAttribute("role", "dialog");
		let head = this.el(doc, "div", "annota-rv-head");
		let h = this.el(doc, "div", "annota-rv-title", title);
		let x = this.button(doc, "✕", "annota-rv-x", () => this.close(window), Annota.t("rv.close"));
		head.appendChild(h);
		head.appendChild(x);
		let body = this.el(doc, "div", "annota-rv-body");
		let foot = this.el(doc, "div", "annota-rv-foot");
		card.appendChild(head);
		card.appendChild(body);
		card.appendChild(foot);
		back.appendChild(card);
		// La fenêtre garde ses touches : Zotero n'y réagit pas.
		for (let type of ["keydown", "keypress", "keyup"]) {
			back.addEventListener(type, e => {
				if (type === "keydown" && e.key === "Escape") { this.close(window); e.preventDefault(); }
				if (type === "keydown" && back._onKey) back._onKey(e);
				e.stopPropagation();
			});
		}
		back.addEventListener("mousedown", e => { if (e.target === back) this.close(window); });
		doc.documentElement.appendChild(back);
		return { back, card, head: h, body, foot, doc };
	},

	close(window) {
		try {
			let old = window.document.getElementById("annota-review");
			if (old) old.remove();
		}
		catch (e) {}
	},

	// Écran de choix de la couleur. onPick(group) reçoit le groupe choisi.
	pickColor(ui, groups, countOf, onPick, hint) {
		let { doc, body, foot } = ui;
		body.textContent = "";
		foot.textContent = "";
		if (hint) body.appendChild(this.el(doc, "p", "annota-rv-hint", hint));
		let grid = this.el(doc, "div", "annota-rv-colors");
		for (let g of groups) {
			let n = countOf(g);
			let b = this.button(doc, "", "annota-rv-color", () => onPick(g));
			let dot = this.el(doc, "span", "annota-rv-dot");
			dot.style.background = g.hex;
			if (g.image) dot.classList.add("annota-rv-dot-area");
			b.appendChild(dot);
			b.appendChild(this.el(doc, "span", "annota-rv-color-label",
				g.label + (g.image ? " · " + Annota.t("rv.areas") : "")));
			b.appendChild(this.el(doc, "span", "annota-rv-count", String(n)));
			if (!n) b.disabled = true;
			grid.appendChild(b);
		}
		if (!groups.length) body.appendChild(this.el(doc, "p", "annota-rv-hint", Annota.t("rv.nocolor")));
		body.appendChild(grid);
	},

	// ---- 1. Le défilé ----

	async startReview(window, wholeLibrary) {
		let selected = !wholeLibrary && (window.ZoteroPane.getSelectedItems() || []).length > 0;
		let ui = this.open(window, Annota.t("rv.title"));
		ui.body.appendChild(this.el(ui.doc, "p", "annota-rv-hint", Annota.t("rv.loading")));
		let anns = await this.annotationsOf(window, !selected);
		let groups = this.groups(anns);
		let empties = new Map(groups.map(g => [g.key, this.sortForReading(g.anns.filter(a => this.isEmpty(a, g.cfg)))]));
		this.pickColor(ui, groups, g => empties.get(g.key).length, g => {
			this.runReview(window, ui, g, empties.get(g.key));
		}, Annota.t(selected ? "rv.pick.sel" : "rv.pick.lib"));
	},

	runReview(window, ui, group, list) {
		let { doc, body, foot } = ui;
		let i = 0, saved = 0, skipped = 0;
		let fields = {}, refs = "", busy = false;

		let finish = () => {
			ui.back._onKey = null;
			body.textContent = "";
			foot.textContent = "";
			body.appendChild(this.el(doc, "div", "annota-rv-done", Annota.t("rv.done")));
			body.appendChild(this.el(doc, "p", "annota-rv-hint",
				Annota.t("rv.summary", { saved, skipped })));
			foot.appendChild(this.button(doc, Annota.t("rv.close"), "annota-rv-primary", () => this.close(window)));
		};

		let read = () => {
			let v = {};
			for (let f of group.cfg.schema) {
				let el = fields[f.name];
				if (!el) { v[f.name] = ""; continue; }
				if (el.type === "checkbox") v[f.name] = el.checked ? "true" : "";
				else if (el.tagName === "DIV") v[f.name] = el._raw || "";
				else v[f.name] = String(el.value || "").trim();
			}
			return v;
		};
		let write = values => {
			for (let f of group.cfg.schema) {
				let el = fields[f.name], v = values[f.name] || "";
				if (!el) continue;
				if (el.type === "checkbox") el.checked = !!v;
				else if (el.tagName === "DIV") { el._raw = v; el.textContent = AnnotaCardFields.plain(v); el.hidden = !v; }
				else { el.value = AnnotaCardFields.plain(v); this.grow(el); }
			}
		};

		let show = async () => {
			if (i >= list.length) { finish(); return; }
			let ann = list[i];
			body.textContent = "";
			foot.textContent = "";
			fields = {};
			refs = "";
			let bar = this.el(doc, "div", "annota-rv-progress");
			let fill = this.el(doc, "div", "annota-rv-progress-fill");
			fill.style.width = Math.round(i / list.length * 100) + "%";
			bar.appendChild(fill);
			body.appendChild(bar);
			let meta = this.el(doc, "div", "annota-rv-meta");
			meta.appendChild(this.el(doc, "span", "annota-rv-step",
				Annota.t("rv.step", { i: i + 1, n: list.length })));
			meta.appendChild(this.el(doc, "span", "annota-rv-source", this.sourceLine(ann)));
			body.appendChild(meta);
			let quote = this.el(doc, "blockquote", "annota-rv-quote", (await this.passage(ann)) || Annota.t("rv.area"));
			quote.style.borderInlineStartColor = group.hex;
			body.appendChild(quote);

			let form = this.el(doc, "div", "annota-rv-form");
			let first = null;
			for (let f of group.cfg.schema) {
				let row = this.el(doc, "label", "annota-rv-field");
				let el;
				if (f.type === "ai") {
					row.appendChild(this.el(doc, "span", "annota-rv-label", f.label + " (IA)"));
					el = this.el(doc, "div", "annota-rv-ai");
					el.hidden = true;
				}
				else if (f.type === "check") {
					el = this.el(doc, "input");
					el.setAttribute("type", "checkbox");
					row.classList.add("annota-rv-check");
					row.appendChild(el);
					row.appendChild(this.el(doc, "span", "annota-rv-label", f.label));
				}
				else if (f.type === "select") {
					row.appendChild(this.el(doc, "span", "annota-rv-label", f.label));
					el = this.el(doc, "select", "annota-rv-input");
					for (let o of [""].concat(f.options || [])) {
						let opt = this.el(doc, "option", null, o);
						opt.setAttribute("value", o);
						el.appendChild(opt);
					}
				}
				else {
					row.appendChild(this.el(doc, "span", "annota-rv-label", f.label));
					el = this.el(doc, "textarea", "annota-rv-input annota-card-input");
					el.setAttribute("rows", "1");
					el.addEventListener("input", () => this.grow(el));
					if (f.type === "text") el.addEventListener("keydown", e => { if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) e.preventDefault(); });
					if (!first) first = el;
				}
				if (f.type !== "check") row.appendChild(el);
				fields[f.name] = el;
				form.appendChild(row);
			}
			body.appendChild(form);
			let status = this.el(doc, "div", "annota-rv-status");
			body.appendChild(status);

			let ai = this.button(doc, "✨ " + Annota.t("rv.ai"), "", async () => {
				if (busy) return;
				let notReady = Annota.providerReadyError();
				if (notReady) { status.textContent = notReady; return; }
				busy = true;
				ai.disabled = true;
				status.textContent = Annota.t("card.filling");
				try {
					let r = await this.aiFill(ann, read());
					if (r) { write(r.values); refs = r.refs; status.textContent = Annota.t("rv.ai.done"); }
					else status.textContent = "";
				}
				catch (e) { status.textContent = Annota.t("gen.failed", { msg: e.message || e }); }
				finally { busy = false; ai.disabled = false; }
			}, Annota.t("rv.ai.title"));
			let openDoc = this.button(doc, Annota.t("rv.open"), "", () => {
				if (AnnotaCiteLink) AnnotaCiteLink.showAnnotation(ann).catch(e => log("défilé : " + e));
				else Zotero.Reader.open(ann.parentItemID, { annotationID: ann.key });
			});
			let prev = this.button(doc, "←", "annota-rv-ghost", () => { if (i > 0) { i--; show(); } }, Annota.t("rv.prev"));
			prev.disabled = i === 0;
			let skip = this.button(doc, Annota.t("rv.skip"), "annota-rv-ghost", () => { skipped++; i++; show(); });
			let next = this.button(doc, Annota.t("rv.savenext"), "annota-rv-primary", async () => {
				if (busy) return;
				busy = true;
				next.disabled = true;
				try {
					let v = read();
					if (group.cfg.schema.some(f => String(v[f.name] || "").trim())) {
						if (await this.save(ann, v, refs)) saved++;
					}
					else skipped++;
					i++;
					busy = false;
					show();
				}
				catch (e) {
					busy = false;
					next.disabled = false;
					status.textContent = Annota.t("card.error") + " " + (e.message || e);
				}
			}, Annota.t("rv.savenext.title"));
			let left = this.el(doc, "div", "annota-rv-foot-group");
			left.appendChild(prev);
			left.appendChild(ai);
			left.appendChild(openDoc);
			let right = this.el(doc, "div", "annota-rv-foot-group");
			right.appendChild(skip);
			right.appendChild(next);
			foot.appendChild(left);
			foot.appendChild(right);
			ui.back._onKey = e => {
				let accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
				if (accel && e.key === "Enter") { e.preventDefault(); next.click(); }
				else if (accel && e.key === "ArrowRight") { e.preventDefault(); skip.click(); }
				else if (accel && e.key === "ArrowLeft") { e.preventDefault(); prev.click(); }
			};
			if (first) first.focus();
		};
		show();
	},

	grow(el) {
		if (!el || el.tagName !== "TEXTAREA") return;
		el.style.height = "auto";
		el.style.height = el.scrollHeight + "px";
	},

	// ---- 2. La relance de l'IA sur des champs choisis ----

	async startRefill(window) {
		let ui = this.open(window, Annota.t("rf.title"));
		ui.body.appendChild(this.el(ui.doc, "p", "annota-rv-hint", Annota.t("rv.loading")));
		let anns = await this.annotationsOf(window, false);
		let groups = this.groups(anns);
		this.pickColor(ui, groups, g => g.anns.length, g => this.refillForm(window, ui, g),
			Annota.t("rf.pick"));
	},

	refillForm(window, ui, group) {
		let { doc, body, foot } = ui;
		body.textContent = "";
		foot.textContent = "";
		body.appendChild(this.el(doc, "p", "annota-rv-hint",
			Annota.t("rf.fields", { label: group.label, n: group.anns.length })));
		let boxes = [];
		let list = this.el(doc, "div", "annota-rv-form");
		for (let f of group.cfg.schema) {
			let row = this.el(doc, "label", "annota-rv-field annota-rv-check");
			let cb = this.el(doc, "input");
			cb.setAttribute("type", "checkbox");
			cb._field = f.name;
			row.appendChild(cb);
			row.appendChild(this.el(doc, "span", "annota-rv-label", f.label + (f.type === "ai" ? " (IA)" : "")));
			list.appendChild(row);
			boxes.push(cb);
		}
		body.appendChild(list);
		let onlyEmpty = this.el(doc, "input");
		onlyEmpty.setAttribute("type", "checkbox");
		let oe = this.el(doc, "label", "annota-rv-field annota-rv-check annota-rv-option");
		oe.appendChild(onlyEmpty);
		oe.appendChild(this.el(doc, "span", "annota-rv-label", Annota.t("rf.onlyempty")));
		body.appendChild(oe);
		let status = this.el(doc, "div", "annota-rv-status");
		body.appendChild(status);
		let go = this.button(doc, Annota.t("rf.go"), "annota-rv-primary", () => {
			let chosen = boxes.filter(b => b.checked).map(b => b._field);
			if (!chosen.length) { status.textContent = Annota.t("rf.none"); return; }
			let notReady = Annota.providerReadyError();
			if (notReady) { status.textContent = notReady; return; }
			this.close(window);
			this.refill(window, group, chosen, onlyEmpty.checked).catch(e => log("relance IA : " + e));
		});
		foot.appendChild(this.button(doc, Annota.t("rv.back"), "annota-rv-ghost", () => this.startRefill(window)));
		foot.appendChild(go);
	},

	// Relance : les champs choisis sont vidés (ou seulement complétés s'ils
	// sont vides), l'IA les remplit ; les autres champs reprennent leur valeur.
	async refill(window, group, chosen, onlyEmpty) {
		let todo = [];
		let unreadable = 0;
		for (let ann of group.anns) {
			let r = this.valuesOf(ann, group.cfg);
			if (!r) { unreadable++; continue; }
			let targets = chosen.filter(n => !onlyEmpty || !String(r.values[n] || "").trim());
			if (targets.length) todo.push({ ann, values: r.values, refs: r.references || "", targets });
		}
		let ps = Services.prompt;
		if (!todo.length) {
			ps.alert(window, "Annota", Annota.t("rf.nothing") + (unreadable ? "\n\n" + Annota.t("rf.unreadable", { n: unreadable }) : ""));
			return;
		}
		if (!ps.confirm(window, "Annota", Annota.t("rf.confirm", { n: todo.length, fields: chosen.length })
			+ (unreadable ? "\n\n" + Annota.t("rf.unreadable", { n: unreadable }) : ""))) return;

		// Sauvegarde des commentaires d'avant.
		let { IO, Path } = AnnotaCiteLink ? AnnotaCiteLink._io() : { IO: IOUtils, Path: PathUtils };
		let dir = Path.join(Zotero.DataDirectory.dir, "annota", "sauvegardes-ia");
		await IO.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let file = Path.join(dir, "relance-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
		let backup = { date: new Date().toISOString(), annotations: [] };

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Annota");
		let line = new pw.ItemProgress("chrome://zotero/skin/tick.png", Annota.t("rf.progress", { i: 0, n: todo.length }));
		pw.show();
		let done = 0, failed = 0;
		for (let k = 0; k < todo.length; k++) {
			let t = todo[k];
			line.setText(Annota.t("rf.progress", { i: k + 1, n: todo.length }));
			line.setProgress(Math.round(k / todo.length * 100));
			try {
				let ask = Object.assign({}, t.values);
				for (let n of t.targets) ask[n] = "";
				// Les champs vides non choisis ne doivent pas être remplis : on
				// les remet à vide après coup.
				let r = await this.aiFill(t.ann, ask);
				if (!r) { failed++; continue; }
				let values = Object.assign({}, t.values);
				for (let n of t.targets) values[n] = r.values[n] || "";
				let before = String(t.ann.annotationComment || "");
				if (await this.save(t.ann, values, r.refs || t.refs)) {
					backup.annotations.push({ libraryID: t.ann.libraryID, key: t.ann.key, before,
						after: String(t.ann.annotationComment || "") });
					done++;
				}
			}
			catch (e) {
				failed++;
				log("relance IA, " + t.ann.key + " : " + e);
			}
			await IO.writeUTF8(file, JSON.stringify(backup));
		}
		line.setProgress(100);
		line.setText(Annota.t("rf.done", { n: done }) + (failed ? " · " + Annota.t("rf.failed", { n: failed }) : ""));
		pw.startCloseTimer(5000);
	},

	async undoRefill(window) {
		let ps = Services.prompt;
		let { IO, Path } = AnnotaCiteLink ? AnnotaCiteLink._io() : { IO: IOUtils, Path: PathUtils };
		let dir = Path.join(Zotero.DataDirectory.dir, "annota", "sauvegardes-ia");
		let files = [];
		try { files = (await IO.getChildren(dir)).filter(f => /relance-.*\.json$/.test(f)).sort(); }
		catch (e) { files = []; }
		if (!files.length) { ps.alert(window, "Annota", Annota.t("rf.noundo")); return; }
		let file = files[files.length - 1];
		let data = JSON.parse(await IO.readUTF8(file));
		if (!ps.confirm(window, "Annota", Annota.t("rf.undoconfirm", { n: data.annotations.length, date: data.date }))) return;
		let restored = 0, kept = 0;
		for (let a of data.annotations) {
			let ann = await Zotero.Items.getByLibraryAndKeyAsync(a.libraryID, a.key);
			if (!ann || String(ann.annotationComment || "") !== a.after) { kept++; continue; }
			ann.annotationComment = a.before;
			await ann.saveTx();
			restored++;
		}
		await IO.move(file, file.replace(/\.json$/, ".annulee.json"));
		ps.alert(window, "Annota", Annota.t("rf.undone", { restored, kept }));
	},

	// ---- Styles ----

	ensureStyles(doc) {
		if (doc.getElementById("annota-review-style")) return;
		let st = doc.createElementNS(this.HTML_NS, "style");
		st.id = "annota-review-style";
		st.textContent = `
.annota-rv-back { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.35); font: 13px/1.45 -apple-system, system-ui, sans-serif; }
.annota-rv-card { display: flex; flex-direction: column; width: min(680px, 92vw); max-height: 88vh;
  background: var(--material-background, Canvas); color: var(--fill-primary, CanvasText);
  border: 1px solid rgba(128,128,128,.3); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
.annota-rv-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 6px; }
.annota-rv-title { flex: 1; font-size: 14px; font-weight: 600; }
.annota-rv-body { padding: 6px 16px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.annota-rv-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px 14px;
  border-top: 1px solid rgba(128,128,128,.2); }
.annota-rv-foot-group { display: flex; gap: 6px; align-items: center; }
.annota-rv-hint { margin: 0; opacity: .75; }
.annota-rv-colors { display: flex; flex-direction: column; gap: 6px; }
.annota-rv-color { display: flex; align-items: center; gap: 10px; text-align: start; padding: 8px 10px !important; }
.annota-rv-color-label { flex: 1; }
.annota-rv-count { font-variant-numeric: tabular-nums; opacity: .7; }
.annota-rv-dot { width: 14px; height: 14px; border-radius: 50%; flex: none; }
.annota-rv-dot-area { border-radius: 3px; }
.annota-rv-btn { appearance: none; margin: 0; padding: 5px 12px; border-radius: 7px; cursor: pointer; font: inherit;
  border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; }
.annota-rv-btn:hover:not(:disabled) { background: rgba(128,128,128,.12); }
.annota-rv-btn:disabled { opacity: .4; cursor: default; }
.annota-rv-primary { background: var(--accent-blue, #2e7cf6); border-color: transparent; color: #fff; }
.annota-rv-primary:hover:not(:disabled) { background: var(--accent-blue, #2e7cf6); filter: brightness(1.08); }
.annota-rv-ghost { border-color: transparent; }
.annota-rv-x { border: none; padding: 2px 8px; opacity: .7; }
.annota-rv-progress { height: 4px; border-radius: 2px; background: rgba(128,128,128,.2); overflow: hidden; }
.annota-rv-progress-fill { height: 100%; background: var(--accent-blue, #2e7cf6); transition: width .25s; }
.annota-rv-meta { display: flex; gap: 10px; align-items: baseline; font-size: 12px; }
.annota-rv-step { font-weight: 600; font-variant-numeric: tabular-nums; }
.annota-rv-source { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annota-rv-quote { margin: 0; padding: 6px 12px; border-inline-start: 4px solid; max-height: 30vh; overflow-y: auto;
  background: rgba(128,128,128,.07); border-radius: 4px; }
.annota-rv-form { display: flex; flex-direction: column; gap: 8px; }
.annota-rv-field { display: flex; flex-direction: column; gap: 3px; }
.annota-rv-check { flex-direction: row; align-items: center; gap: 8px; }
.annota-rv-option { margin-top: 4px; opacity: .85; }
.annota-rv-label { font-size: 12px; opacity: .75; }
.annota-rv-input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.35);
  background: var(--material-sidepane, Field); color: inherit; resize: vertical; min-height: 1.6em; }
.annota-rv-ai { padding: 6px 8px; border-radius: 6px; background: rgba(128,128,128,.08); white-space: pre-wrap; }
.annota-rv-status { min-height: 1.2em; font-size: 12px; opacity: .8; }
.annota-rv-done { font-size: 18px; font-weight: 600; }
`;
		(doc.head || doc.documentElement).appendChild(st);
	}
};
