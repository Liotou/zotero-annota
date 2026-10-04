/* eslint-disable no-undef */
// Annota — orthographe et grammaire pendant la frappe, partout où l'on écrit.
//
// Zones surveillées : les éditeurs de notes (bibliothèque, volet du lecteur,
// fenêtres de note) et les commentaires d'annotation du lecteur. Annota ne
// modifie pas ces éditeurs : il écoute la frappe dans leur document, vérifie
// le texte après une pause (correcteur de macOS, spell.js) et souligne les
// fautes par l'API de surlignage CSS (CSS.highlights), qui marque des plages
// de texte sans toucher au contenu.
//
// Une correction est saisie comme une frappe (execCommand « insertText ») :
// l'éditeur l'enregistre et l'annule (⌘Z) comme n'importe quelle saisie.
// Sans API de surlignage (Zotero ancien), le badge et la bulle restent.

var AnnotaSpellLive = {
	DELAY: 1200,           // pause de frappe avant vérification, en ms
	SCAN: 2000,            // recherche de nouveaux éditeurs, en ms
	MAX: 50000,            // au-delà, le texte n'est pas vérifié en direct
	BLOCKS: /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|TD|TH|TR|UL|OL|TABLE|SECTION|ARTICLE|HEADER|FOOTER)$/,

	_docs: new Map(),      // document → { states, timers, handlers, popover, badge }
	_timer: null,
	_broken: false,
	ignored: new Set(),    // mots ignorés pour la session

	enabled() {
		return !this._broken && !!AnnotaSpell && AnnotaSpell.available()
			&& getPref("spellLive", true) !== false;
	},

	start() {
		this.stop();
		let tick = () => {
			try {
				if (this.enabled()) this.scan();
				else this.detachAll();
			}
			catch (e) { log("orthographe en direct : " + e); }
			this._timer = setTimeout(tick, this.SCAN);
		};
		tick();
	},

	stop() {
		if (this._timer) clearTimeout(this._timer);
		this._timer = null;
		this.detachAll();
	},

	// ---- Repérage des éditeurs ----

	scan() {
		let en = Services.wm.getEnumerator(null);
		while (en.hasMoreElements()) {
			let w = en.getNext();
			let d;
			try { d = w.document; } catch (e) { continue; }
			if (!d || !d.querySelectorAll) continue;
			for (let ne of d.querySelectorAll("note-editor")) {
				try {
					let f = ne._iframe || ne.querySelector("iframe")
						|| (ne.shadowRoot && ne.shadowRoot.querySelector("iframe"));
					let fd = f && f.contentDocument;
					if (fd && fd.body) this.attach(fd);
				}
				catch (e) { /* éditeur en cours de chargement */ }
			}
		}
		for (let r of (Zotero.Reader && Zotero.Reader._readers) || []) {
			try {
				let d = r._iframeWindow && r._iframeWindow.document;
				if (d && d.body) this.attach(d);
			}
			catch (e) {}
		}
		// Documents disparus (note fermée, onglet fermé) : on oublie.
		for (let doc of Array.from(this._docs.keys())) {
			let alive = false;
			try { alive = !!doc.defaultView && !doc.defaultView.closed && !!doc.body; } catch (e) {}
			if (!alive) this._docs.delete(doc);
		}
	},

	attach(doc) {
		if (this._docs.has(doc)) return;
		let rec = { states: new Map(), timers: new Map(), popover: null, badge: null, badgeFor: null };
		let h = {
			input: (e) => this.onInput(doc, rec, e),
			focusin: (e) => {
				let el = this.editableRoot(e.target);
				if (el && !rec.states.has(el)) this.schedule(doc, rec, el, 300);
				if (el) this.showBadge(doc, rec, el);
			},
			focusout: () => {
				let w = doc.defaultView;
				w.setTimeout(() => {
					if (rec.popover) return;
					let el = this.editableRoot(doc.activeElement);
					if (!el) this.hideBadge(rec);
				}, 200);
			},
			mouseup: (e) => {
				if (rec.popover && rec.popover.contains(e.target)) return;
				if (rec.badge && rec.badge.contains(e.target)) return;
				this.onCaret(doc, rec);
			},
			keyup: (e) => {
				if (e.key === "Escape") { this.closePopover(rec); return; }
				if (/^Arrow|^Home$|^End$/.test(e.key)) this.onCaret(doc, rec);
			},
			mousedown: (e) => {
				if (rec.popover && !rec.popover.contains(e.target)) this.closePopover(rec);
			},
			scroll: () => {
				this.closePopover(rec);
				if (rec.badgeFor) this.placeBadge(doc, rec, rec.badgeFor);
			}
		};
		doc.addEventListener("input", h.input, true);
		doc.addEventListener("focusin", h.focusin, true);
		doc.addEventListener("focusout", h.focusout, true);
		doc.addEventListener("mouseup", h.mouseup, true);
		doc.addEventListener("keyup", h.keyup, true);
		doc.addEventListener("mousedown", h.mousedown, true);
		doc.addEventListener("scroll", h.scroll, true);
		rec.handlers = h;
		this.injectStyle(doc);
		this._docs.set(doc, rec);
		// Éditeur déjà focalisé (note ouverte avant l'activation) : on vérifie.
		let el = this.editableRoot(doc.activeElement);
		if (el) this.schedule(doc, rec, el, 300);
	},

	detach(doc) {
		let rec = this._docs.get(doc);
		this._docs.delete(doc);
		if (!rec) return;
		try {
			let h = rec.handlers;
			for (let [type, fn] of Object.entries(h)) doc.removeEventListener(type, fn, true);
			for (let t of rec.timers.values()) doc.defaultView.clearTimeout(t);
			this.closePopover(rec);
			this.hideBadge(rec);
			let st = doc.getElementById("annota-spell-live-style");
			if (st) st.remove();
			let reg = this.registry(doc);
			if (reg) { reg.delete("annota-spelling"); reg.delete("annota-grammar"); }
		}
		catch (e) { /* document fermé */ }
	},

	detachAll() {
		for (let doc of Array.from(this._docs.keys())) this.detach(doc);
	},

	// Racine éditable d'un élément : la plus haute zone contenteditable, hors
	// champs de formulaire (le formulaire de champs d'Annota en a).
	editableRoot(t) {
		try {
			if (t && t.nodeType !== 1) t = t.parentElement;
			if (!t || !t.closest) return null;
			if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return null;
			if (t.closest(".annota-live-pop, .annota-live-badge")) return null;
			let el = t.closest('[contenteditable="true"], [contenteditable=""]');
			if (!el || !el.isContentEditable) return null;
			let up = el.parentElement && el.parentElement.closest('[contenteditable="true"], [contenteditable=""]');
			while (up) {
				el = up;
				up = el.parentElement && el.parentElement.closest('[contenteditable="true"], [contenteditable=""]');
			}
			return el;
		}
		catch (e) { return null; }
	},

	// ---- Vérification ----

	onInput(doc, rec, e) {
		let el = this.editableRoot(e.target);
		if (!el) return;
		// Le texte a bougé : les soulignements d'avant seraient décalés.
		let st = rec.states.get(el);
		if (st && st.issues.length) {
			st.issues = [];
			this.refreshHighlights(doc, rec);
		}
		this.closePopover(rec);
		this.schedule(doc, rec, el, this.DELAY);
	},

	schedule(doc, rec, el, delay) {
		let w = doc.defaultView;
		let prev = rec.timers.get(el);
		if (prev) w.clearTimeout(prev);
		rec.timers.set(el, w.setTimeout(() => {
			rec.timers.delete(el);
			this.check(doc, rec, el).catch(e => log("orthographe en direct : " + e));
		}, delay));
	},

	// Texte visible de la zone et correspondance vers ses nœuds de texte. Un
	// saut de ligne sépare les blocs (paragraphes, éléments de liste…).
	snapshot(el) {
		let doc = el.ownerDocument;
		let walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
		let text = "", segs = [], lastBlock = null, node;
		while ((node = walker.nextNode())) {
			let data = node.data;
			if (!data) continue;
			let block = node.parentElement;
			while (block && block !== el && !this.BLOCKS.test(block.tagName)) block = block.parentElement;
			if (lastBlock && block !== lastBlock && text && !text.endsWith("\n")) text += "\n";
			lastBlock = block;
			segs.push({ node, start: text.length, end: text.length + data.length });
			text += data;
		}
		return { text, segs };
	},

	toRange(doc, snap, a, b) {
		if (b <= a || snap.text.slice(a, b).includes("\n")) return null;
		let s = snap.segs.find(x => a >= x.start && a < x.end);
		let e = snap.segs.find(x => b - 1 >= x.start && b - 1 < x.end);
		if (!s || !e) return null;
		try {
			let r = doc.createRange();
			r.setStart(s.node, a - s.start);
			r.setEnd(e.node, b - e.start);
			return r;
		}
		catch (err) { return null; }
	},

	async check(doc, rec, el) {
		if (!this.enabled()) return;
		if (!el.isConnected) {
			rec.states.delete(el);
			this.refreshHighlights(doc, rec);
			return;
		}
		let snap = this.snapshot(el);
		if (!snap.text.trim() || snap.text.length > this.MAX) {
			rec.states.set(el, { text: snap.text, issues: [] });
			this.refreshHighlights(doc, rec);
			this.showBadge(doc, rec, el);
			return;
		}
		let res;
		try { res = await AnnotaSpell.check([snap.text]); }
		catch (e) {
			// Correcteur indisponible : on s'arrête plutôt que de relancer
			// osascript à chaque frappe.
			this._broken = true;
			log("orthographe en direct désactivée : " + e);
			this.detachAll();
			return;
		}
		// Frappe pendant la vérification : le résultat ne correspond plus.
		if (!el.isConnected || this.snapshot(el).text !== snap.text) return;
		let issues = AnnotaSpell.normalize(snap.text, res[0])
			.filter(x => !this.ignored.has(x.word));
		for (let x of issues) x.range = this.toRange(doc, snap, x.start, x.start + x.length);
		rec.states.set(el, { text: snap.text, issues: issues.filter(x => x.range) });
		this.refreshHighlights(doc, rec);
		this.showBadge(doc, rec, el);
	},

	// ---- Soulignement ----

	registry(doc) {
		try {
			let w = doc.defaultView;
			return (w && w.CSS && w.CSS.highlights && typeof w.Highlight === "function")
				? w.CSS.highlights : null;
		}
		catch (e) { return null; }
	},

	refreshHighlights(doc, rec) {
		let reg = this.registry(doc);
		if (!reg) return;
		let sp = [], gr = [];
		for (let st of rec.states.values()) {
			for (let x of st.issues) (x.type === "grammar" ? gr : sp).push(x.range);
		}
		try {
			let w = doc.defaultView;
			if (sp.length) reg.set("annota-spelling", new w.Highlight(...sp));
			else reg.delete("annota-spelling");
			if (gr.length) reg.set("annota-grammar", new w.Highlight(...gr));
			else reg.delete("annota-grammar");
		}
		catch (e) { log("orthographe en direct, soulignement : " + e); }
	},

	// ---- Bulle de correction ----

	onCaret(doc, rec) {
		let sel = doc.getSelection();
		if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
		let el = this.editableRoot(sel.anchorNode);
		let st = el && rec.states.get(el);
		if (!st) { this.closePopover(rec); return; }
		let hit = st.issues.find(x => {
			try {
				return x.range.comparePoint(sel.anchorNode, sel.anchorOffset) === 0
					&& !x.range.collapsed;
			}
			catch (e) { return false; }
		});
		if (hit) this.openPopover(doc, rec, el, [hit], hit.range.getBoundingClientRect());
		else this.closePopover(rec);
	},

	closePopover(rec) {
		if (rec.popover) {
			try { rec.popover.remove(); } catch (e) {}
			rec.popover = null;
		}
	},

	mk(doc, tag, cls, text) {
		let e = doc.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	},

	// Bouton qui n'enlève pas le focus à l'éditeur (la sélection y reste).
	btn(doc, label, cls, fn, title) {
		let b = this.mk(doc, "button", cls, label);
		b.type = "button";
		if (title) b.title = title;
		b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
		b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
		return b;
	},

	openPopover(doc, rec, el, issues, rect) {
		this.closePopover(rec);
		let pop = this.mk(doc, "div", "annota-live-pop");
		pop.setAttribute("role", "dialog");
		let list = issues.length > 1;
		if (list) {
			pop.appendChild(this.mk(doc, "div", "annota-live-title",
				Annota.t("sp.badge", { n: issues.length })));
		}
		for (let x of issues) {
			let row = this.mk(doc, "div", "annota-live-row");
			let head = this.mk(doc, "div", "annota-live-head");
			head.appendChild(this.mk(doc, "span", "annota-live-kind annota-live-" + x.type,
				Annota.t(x.type === "grammar" ? "sp.grammar" : "sp.spelling")));
			if (list) head.appendChild(this.mk(doc, "span", "annota-live-word", x.word));
			row.appendChild(head);
			if (x.message) row.appendChild(this.mk(doc, "div", "annota-live-msg", x.message));
			let acts = this.mk(doc, "div", "annota-live-acts");
			for (let s of x.suggestions) {
				acts.appendChild(this.btn(doc, s, "annota-live-sug",
					() => this.replace(doc, rec, el, [{ issue: x, text: s }]),
					Annota.t("sp.replace", { w: s })));
			}
			if (!x.suggestions.length) acts.appendChild(this.mk(doc, "span", "annota-live-none", Annota.t("sp.nosug")));
			acts.appendChild(this.btn(doc, Annota.t("sp.ignore"), "annota-live-link", () => {
				this.ignore(doc, rec, x.word);
			}));
			if (x.type === "spelling") {
				acts.appendChild(this.btn(doc, Annota.t("sp.learn"), "annota-live-link", () => {
					AnnotaSpell.learn(x.word).catch(e => log("orthographe : " + e));
					this.ignore(doc, rec, x.word);
				}, Annota.t("sp.learn.title")));
			}
			row.appendChild(acts);
			pop.appendChild(row);
		}
		if (list && issues.some(x => x.suggestions.length)) {
			let all = this.btn(doc, Annota.t("sp.all"), "annota-live-all", () => {
				this.replace(doc, rec, el, issues.filter(x => x.suggestions.length)
					.map(x => ({ issue: x, text: x.suggestions[0] })));
			}, Annota.t("sp.all.title"));
			pop.appendChild(all);
		}
		(doc.body || doc.documentElement).appendChild(pop);
		rec.popover = pop;
		// Sous le mot, ou au-dessus s'il n'y a pas la place ; jamais hors cadre.
		let w = doc.defaultView;
		let pw = pop.offsetWidth, ph = pop.offsetHeight;
		let left = Math.max(6, Math.min(rect.left, w.innerWidth - pw - 6));
		let top = rect.bottom + 6;
		if (top + ph > w.innerHeight - 6) top = Math.max(6, rect.top - ph - 6);
		pop.style.left = left + "px";
		pop.style.top = top + "px";
	},

	ignore(doc, rec, word) {
		this.ignored.add(word);
		for (let st of rec.states.values()) st.issues = st.issues.filter(x => x.word !== word);
		this.closePopover(rec);
		this.refreshHighlights(doc, rec);
		if (rec.badgeFor) this.showBadge(doc, rec, rec.badgeFor);
	},

	// Remplacements saisis comme une frappe. Du dernier au premier : les
	// positions des fautes précédentes restent alors exactes, quel que soit
	// le nombre de nœuds que l'éditeur réécrit.
	replace(doc, rec, el, edits) {
		this.closePopover(rec);
		edits.sort((p, q) => q.issue.start - p.issue.start);
		let done = 0;
		for (let { issue, text } of edits) {
			let snap = this.snapshot(el);
			if (snap.text.slice(issue.start, issue.start + issue.length) !== issue.word) continue;
			let r = this.toRange(doc, snap, issue.start, issue.start + issue.length);
			if (!r) continue;
			try {
				el.focus();
				let sel = doc.getSelection();
				sel.removeAllRanges();
				sel.addRange(r);
				if (doc.execCommand("insertText", false, text)) done++;
			}
			catch (e) { log("orthographe en direct, remplacement : " + e); }
		}
		if (done < edits.length) toast("Annota", Annota.t("sp.err.some", { n: edits.length - done }), "error");
		// La frappe simulée déclenche « input » : la vérification suivra.
	},

	// ---- Badge : nombre de fautes de la zone en cours ----

	showBadge(doc, rec, el) {
		let st = rec.states.get(el);
		let n = st ? st.issues.length : 0;
		let focused = this.editableRoot(doc.activeElement) === el;
		if (!n || !focused) {
			if (rec.badgeFor === el || !n) this.hideBadge(rec);
			return;
		}
		if (!rec.badge) {
			let b = this.mk(doc, "button", "annota-live-badge");
			b.type = "button";
			b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				let target = rec.badgeFor, s = target && rec.states.get(target);
				if (!s || !s.issues.length) return;
				if (rec.popover) { this.closePopover(rec); return; }
				this.openPopover(doc, rec, target, s.issues.slice(0, 12), b.getBoundingClientRect());
			});
			(doc.body || doc.documentElement).appendChild(b);
			rec.badge = b;
		}
		rec.badgeFor = el;
		rec.badge.textContent = Annota.t("sp.badge", { n });
		rec.badge.title = Annota.t("sp.badge.title");
		rec.badge.hidden = false;
		this.placeBadge(doc, rec, el);
	},

	placeBadge(doc, rec, el) {
		if (!rec.badge || rec.badge.hidden) return;
		try {
			let w = doc.defaultView, r = el.getBoundingClientRect();
			let bw = rec.badge.offsetWidth || 60, bh = rec.badge.offsetHeight || 20;
			let left = Math.min(r.right, w.innerWidth) - bw - 6;
			let top = Math.min(r.bottom, w.innerHeight) - bh - 6;
			rec.badge.style.left = Math.max(4, left) + "px";
			rec.badge.style.top = Math.max(4, top) + "px";
		}
		catch (e) {}
	},

	hideBadge(rec) {
		if (rec.badge) rec.badge.hidden = true;
		rec.badgeFor = null;
	},

	// ---- Styles injectés dans chaque éditeur ----

	injectStyle(doc) {
		if (doc.getElementById("annota-spell-live-style")) return;
		let st = doc.createElement("style");
		st.id = "annota-spell-live-style";
		st.textContent = `
::highlight(annota-spelling) { text-decoration: underline wavy #e5484d; text-decoration-skip-ink: none;
  text-underline-offset: 2px; background-color: rgba(229, 72, 77, .10); }
::highlight(annota-grammar) { text-decoration: underline wavy #2ea8e5; text-decoration-skip-ink: none;
  text-underline-offset: 2px; background-color: rgba(46, 168, 229, .10); }
.annota-live-pop { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px;
  max-width: 300px; max-height: 60vh; overflow-y: auto; box-sizing: border-box; padding: 9px 10px;
  border-radius: 8px; border: 1px solid rgba(128,128,128,.35); background: Canvas; color: CanvasText;
  box-shadow: 0 6px 18px rgba(0,0,0,.18); font: 12.5px/1.4 -apple-system, system-ui, sans-serif; }
.annota-live-title { font-weight: 600; font-size: 12px; }
.annota-live-row { display: flex; flex-direction: column; gap: 5px; }
.annota-live-row + .annota-live-row { padding-top: 8px; border-top: 1px solid rgba(128,128,128,.25); }
.annota-live-head { display: flex; align-items: center; gap: 6px; }
.annota-live-kind { padding: 0 6px; border-radius: 4px; font-size: 10.5px; font-weight: 600; }
.annota-live-spelling { background: rgba(229,72,77,.12); color: #e5484d; }
.annota-live-grammar { background: rgba(46,168,229,.12); color: #1f8bc4; }
.annota-live-word { text-decoration: underline wavy #e5484d; text-underline-offset: 2px; }
.annota-live-msg { font-size: 11.5px; opacity: .75; }
.annota-live-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.annota-live-sug { appearance: none; margin: 0; padding: 2px 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; font: inherit; }
.annota-live-sug:hover { border-color: #22c55e; background: rgba(34,197,94,.10); }
.annota-live-none { font-size: 11.5px; opacity: .55; }
.annota-live-link, .annota-live-all { appearance: none; margin: 0; padding: 0; border: none; background: none;
  color: inherit; opacity: .7; font: inherit; font-size: 11.5px; cursor: pointer; }
.annota-live-link:hover { opacity: 1; text-decoration: underline; }
.annota-live-all { align-self: flex-start; opacity: 1; color: #2e7cf6; }
.annota-live-badge { position: fixed; z-index: 2147483646; margin: 0; padding: 1px 8px; border-radius: 999px;
  border: 1px solid rgba(229,72,77,.45); background: Canvas; color: #e5484d; cursor: pointer;
  font: 600 11px/1.6 -apple-system, system-ui, sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.annota-live-badge[hidden] { display: none; }
`;
		(doc.head || doc.documentElement).appendChild(st);
	}
};
