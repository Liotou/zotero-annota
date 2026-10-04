/* eslint-disable no-undef */
// Annota — orthographe et grammaire par le correcteur de macOS.
//
// Moteur : NSSpellChecker, celui de Pages, Mail ou TextEdit, interrogé par
// osascript en JavaScript (JXA), comme Ariane le fait pour Rappels et Agenda.
// Rien à installer ni à compiler, aucune clé : tout reste sur le Mac.
//
// Les commentaires d'annotation et les notes contiennent du balisage (<b>,
// <i>, paragraphes, entités). Seul le texte visible est vérifié ; une table
// de correspondance ramène chaque faute à sa place dans la chaîne d'origine,
// si bien qu'une correction ne touche jamais au balisage.
//
// La revue s'affiche dans le panneau Annota (vue « Correction ») ; chaque
// correction acceptée est enregistrée aussitôt dans l'item.

var AnnotaSpell = {
	OSASCRIPT: "/usr/bin/osascript",

	// Script JXA. Arguments : « check » <textes en JSON> <langue> <grammaire 0/1>,
	// ou « learn » <mot>. Renvoie du JSON sur la sortie standard.
	// NB : on ne lit aucun paramètre de sortie NSError** (Ariane a constaté
	// qu'osascript s'y plante) ; orthography et wordCount sont passés à nil.
	JXA: [
		"ObjC.import('AppKit');",
		"function issuesFor(sc, tag, text, grammar) {",
		"  var ns = $(text);",
		"  var len = ns.length;",
		"  if (!len) return [];",
		"  var types = grammar ? (2 | 4) : 2;",
		"  var res = sc.checkStringRangeTypesOptionsInSpellDocumentWithTagOrthographyWordCount(",
		"    ns, $.NSMakeRange(0, len), types, $.NSDictionary.dictionary, tag, null, null);",
		"  var out = [];",
		"  var n = res ? res.count : 0;",
		"  for (var i = 0; i < n; i++) {",
		"    var r = res.objectAtIndex(i);",
		"    var rg = r.range;",
		"    if (r.resultType == 2) {",
		"      var g = sc.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(rg, ns, sc.language, tag);",
		"      out.push({ type: 'spelling', start: rg.location, length: rg.length,",
		"        suggestions: g ? ObjC.deepUnwrap(g) : [] });",
		"    } else if (r.resultType == 4) {",
		"      var det = r.grammarDetails;",
		"      var dn = det ? det.count : 0;",
		"      if (!dn) out.push({ type: 'grammar', sentence: rg.location, start: 0,",
		"        length: rg.length, message: '', suggestions: [] });",
		"      for (var k = 0; k < dn; k++) {",
		"        var d = det.objectAtIndex(k);",
		"        var v = d.objectForKey('NSGrammarRange');",
		"        var dr = v ? v.rangeValue : { location: 0, length: rg.length };",
		"        var desc = d.objectForKey('NSGrammarUserDescription');",
		"        var corr = d.objectForKey('NSGrammarCorrections');",
		"        out.push({ type: 'grammar', sentence: rg.location, start: dr.location,",
		"          length: dr.length, message: desc ? ObjC.unwrap(desc) : '',",
		"          suggestions: corr ? ObjC.deepUnwrap(corr) : [] });",
		"      }",
		"    }",
		"  }",
		"  return out;",
		"}",
		"function run(argv) {",
		"  var sc = $.NSSpellChecker.sharedSpellChecker;",
		"  if (argv[0] === 'learn') { sc.learnWord($(argv[1])); return '{\"ok\":true}'; }",
		"  var texts = JSON.parse(argv[1] || '[]');",
		"  var lang = argv[2] || '';",
		"  var grammar = argv[3] === '1';",
		"  if (lang) { sc.automaticallyIdentifiesLanguages = false; sc.setLanguage($(lang)); }",
		"  else sc.automaticallyIdentifiesLanguages = true;",
		"  var tag = $.NSSpellChecker.uniqueSpellDocumentTag;",
		"  var all = texts.map(function (t) {",
		"    try { return issuesFor(sc, tag, t, grammar); }",
		"    catch (e) { return { error: String(e) }; }",
		"  });",
		"  try { sc.closeSpellDocumentWithTag(tag); } catch (e) {}",
		"  return JSON.stringify(all);",
		"}"
	].join("\n"),

	// Balises après lesquelles le texte visible passe à la ligne : sans cela,
	// deux paragraphes collés formeraient des mots ou des phrases fautifs.
	BLOCK_TAGS: /^(p|div|h[1-6]|li|ul|ol|br|blockquote|tr|td|th|pre|table|hr)$/i,

	ENTITIES: { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " },

	available() {
		try { return !!Zotero.isMac; } catch (e) { return false; }
	},

	// ---- Texte visible ↔ chaîne d'origine ----

	// starts[i] / ends[i] : position, dans la chaîne d'origine, du caractère
	// visible i. virt[i] : saut de ligne ajouté pour une balise de bloc (il
	// n'existe pas dans l'original ; une correction ne peut pas le traverser).
	visible(raw) {
		raw = String(raw || "");
		let text = "", starts = [], ends = [], virt = [];
		let push = (s, a, b, v) => {
			for (let k = 0; k < s.length; k++) {
				text += s[k];
				starts.push(a);
				ends.push(b);
				virt.push(!!v);
			}
		};
		let i = 0;
		while (i < raw.length) {
			let c = raw[i];
			if (c === "<") {
				let j = raw.indexOf(">", i);
				let m = j > i && raw.slice(i + 1, j).match(/^\/?\s*([a-z][a-z0-9]*)/i);
				if (m) {
					if (this.BLOCK_TAGS.test(m[1]) && text && !text.endsWith("\n")) push("\n", i, i, true);
					i = j + 1;
					continue;
				}
			}
			if (c === "&") {
				let m = raw.slice(i, i + 12).match(/^&(#x[0-9a-f]+|#\d+|[a-z]+);/i);
				if (m) {
					let name = m[1], ch = null;
					if (name[0] === "#") {
						let code = name[1] === "x" || name[1] === "X"
							? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
						try { ch = String.fromCodePoint(code); } catch (e) { ch = null; }
					}
					else ch = this.ENTITIES[name.toLowerCase()] || null;
					if (ch !== null) {
						push(ch, i, i + m[0].length, false);
						i += m[0].length;
						continue;
					}
				}
			}
			push(c, i, i + 1, false);
			i++;
		}
		// Le saut ajouté par la dernière balise fermante ne sépare plus rien.
		while (virt.length && virt[virt.length - 1]) {
			virt.pop(); starts.pop(); ends.pop();
			text = text.slice(0, -1);
		}
		return { text, starts, ends, virt };
	},

	// Plage visible [a, b) → plage d'origine, ou null si elle traverse un saut
	// de ligne ajouté.
	rawRange(vis, a, b) {
		if (a < 0 || b > vis.text.length || b <= a) return null;
		for (let k = a; k < b; k++) if (vis.virt[k]) return null;
		return [vis.starts[a], vis.ends[b - 1]];
	},

	escape(s, html) {
		s = String(s);
		if (html) s = s.replace(/&/g, "&amp;");
		return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	},

	// ---- Moteur ----

	async osascript(args) {
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let proc = await Subprocess.call({
			command: this.OSASCRIPT,
			arguments: ["-l", "JavaScript", "-e", this.JXA].concat(args),
			stderr: "pipe"
		});
		let timer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 60000);
		try {
			let out = "", err = "", c;
			while ((c = await proc.stdout.readString()) !== "") out += c;
			while ((c = await proc.stderr.readString()) !== "") err += c;
			let { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new Error(Annota.t("sp.err.engine", { msg: (err.trim() || "code " + exitCode).slice(0, 300) }));
			}
			return out.trim();
		}
		finally { clearTimeout(timer); }
	},

	language() {
		let l = String(getPref("spellLanguage", "auto") || "auto");
		return l === "auto" ? "" : l;
	},

	// Fautes de chaque texte, par lots (la ligne de commande a une taille
	// maximale). Positions en unités UTF-16, comme les chaînes JavaScript.
	async check(texts) {
		let grammar = getPref("spellGrammar", true) !== false;
		let out = [], batch = [], size = 0;
		let flush = async () => {
			if (!batch.length) return;
			let res = JSON.parse(await this.osascript(["check", JSON.stringify(batch),
				this.language(), grammar ? "1" : "0"]) || "[]");
			for (let k = 0; k < batch.length; k++) out.push(Array.isArray(res[k]) ? res[k] : []);
			batch = [];
			size = 0;
		};
		for (let t of texts) {
			if (size + t.length > 60000) await flush();
			batch.push(t);
			size += t.length;
		}
		await flush();
		return out;
	},

	async learn(word) {
		await this.osascript(["learn", word]);
	},

	// Fautes brutes du moteur → fautes situées dans le texte visible. Pour la
	// grammaire, Apple donne la plage du détail relativement à la phrase ; un
	// détail qui sortirait du texte est rapporté à la phrase entière.
	normalize(text, issues) {
		let out = [];
		for (let x of issues || []) {
			let start = x.start, length = x.length;
			if (x.type === "grammar") {
				let abs = (x.sentence || 0) + (x.start || 0);
				start = abs + length <= text.length ? abs : (x.sentence || 0);
			}
			if (!(length > 0) || start < 0 || start + length > text.length) continue;
			let word = text.slice(start, start + length);
			let suggestions = (x.suggestions || []).filter(s => typeof s === "string" && s && s !== word)
				.slice(0, 6);
			out.push({ type: x.type === "grammar" ? "grammar" : "spelling", start, length, word,
				message: String(x.message || ""), suggestions, state: "open" });
		}
		out.sort((a, b) => a.start - b.start);
		// Une faute d'orthographe et une remarque de grammaire sur le même mot :
		// on garde l'orthographe, plus précise.
		return out.filter((x, i) => !out.some((y, j) => j !== i && y.type === "spelling"
			&& x.type === "grammar" && y.start === x.start && y.length === x.length));
	},

	// ---- Cibles ----

	targetFromItem(item) {
		if (!item) return null;
		try {
			if (item.isAnnotation && item.isAnnotation()) {
				let raw = String(item.annotationComment || "");
				if (!raw.trim()) return null;
				return { id: item.id, kind: "annotation", raw, color: item.annotationColor,
					page: item.annotationPageLabel || "",
					quote: String(item.annotationText || "").replace(/\s+/g, " ").trim() };
			}
			if (item.isNote && item.isNote()) {
				let raw = String(item.getNote() || "");
				if (!raw.trim()) return null;
				return { id: item.id, kind: "note", raw,
					title: (item.getNoteTitle && item.getNoteTitle()) || "" };
			}
		}
		catch (e) { log("orthographe, cible : " + e); }
		return null;
	},

	// Sélection de la bibliothèque : annotations des pièces jointes, notes
	// filles et notes sélectionnées.
	async targetsFromSelection(items) {
		let out = [], seen = new Set();
		let add = (it) => {
			if (!it || seen.has(it.id)) return;
			seen.add(it.id);
			let t = this.targetFromItem(it);
			if (t) out.push(t);
		};
		for (let it of items) {
			try {
				if (it.isNote && it.isNote()) { add(it); continue; }
				if (it.isAnnotation && it.isAnnotation()) { add(it); continue; }
				if (it.isRegularItem && it.isRegularItem()) {
					for (let id of it.getNotes()) add(Zotero.Items.get(id));
				}
			}
			catch (e) { log("orthographe, sélection : " + e); }
		}
		for (let ann of await Annota.collectAnnotations(items)) add(ann);
		return out;
	},

	// ---- Session de revue ----

	// Lance la vérification et ouvre la vue de correction du panneau.
	async review(win, targets) {
		if (!this.available()) {
			toast("Annota", Annota.t("sp.mac"), "error");
			return;
		}
		if (!AnnotaChat) return;
		targets = (targets || []).filter(Boolean);
		if (!targets.length) {
			toast("Annota", Annota.t("sp.none"));
			return;
		}
		AnnotaChat.toggle(win, true);
		let rec = AnnotaChat._windows.get(win);
		let inst = rec && AnnotaChat.activeInstance(rec);
		if (!inst) return;
		let session = { targets, busy: true, error: "", checked: 0 };
		inst.spell = session;
		inst.historyOpen = false;
		AnnotaChat.renderInstance(inst);
		try {
			for (let t of targets) t.vis = this.visible(t.raw);
			let res = await this.check(targets.map(t => t.vis.text));
			targets.forEach((t, k) => { t.issues = this.normalize(t.vis.text, res[k]); });
		}
		catch (e) {
			session.error = String(e.message || e);
			log("orthographe : " + session.error);
		}
		session.busy = false;
		if (inst.spell === session) AnnotaChat.renderInstance(inst);
	},

	async save(t, raw) {
		let it = Zotero.Items.get(t.id);
		if (!it) throw new Error(Annota.t("sp.err.gone"));
		if (t.kind === "annotation") it.annotationComment = raw;
		else it.setNote(raw);
		await it.saveTx();
	},

	current(t) {
		let it = Zotero.Items.get(t.id);
		if (!it) return null;
		return t.kind === "annotation" ? String(it.annotationComment || "") : String(it.getNote() || "");
	},

	// Applique un remplacement à une faute, enregistre, puis recale les
	// positions des fautes suivantes du même texte.
	async apply(t, issue, replacement) {
		if (this.current(t) !== t.raw) {
			// Modifié ailleurs entre-temps : on ne réécrit pas à l'aveugle.
			throw new Error(Annota.t("sp.err.changed"));
		}
		let r = this.rawRange(t.vis, issue.start, issue.start + issue.length);
		if (!r) throw new Error(Annota.t("sp.err.range"));
		let raw = t.raw.slice(0, r[0]) + this.escape(replacement, t.kind === "note") + t.raw.slice(r[1]);
		await this.save(t, raw);
		let delta = replacement.length - issue.length;
		let end = issue.start + issue.length;
		for (let x of t.issues) {
			if (x === issue || x.state !== "open") continue;
			if (x.start >= end) x.start += delta;
			else if (x.start + x.length > issue.start) x.state = "stale";
		}
		issue.state = "fixed";
		issue.applied = replacement;
		t.raw = raw;
		t.vis = this.visible(raw);
	},

	// Première suggestion de chaque faute qui en a une, texte par texte.
	async applyAll(session) {
		let n = 0, failed = 0;
		for (let t of session.targets) {
			for (let x of (t.issues || []).slice()) {
				if (x.state !== "open" || !x.suggestions.length) continue;
				try { await this.apply(t, x, x.suggestions[0]); n++; }
				catch (e) { failed++; log("orthographe : " + e); }
			}
		}
		return { n, failed };
	},

	// ---- Vue « Correction » du panneau ----

	render(inst) {
		let C = AnnotaChat, doc = inst.doc, s = inst.spell;
		let wrap = C.el(doc, "div", "annota-spell");
		let head = C.el(doc, "div", "annota-spell-head");
		head.appendChild(C.el(doc, "div", "annota-history-title", Annota.t("sp.title")));
		let close = C.button(doc, Annota.t("sp.done"), "annota-link-btn", () => {
			inst.spell = null;
			C.renderInstance(inst);
		});
		head.appendChild(close);
		wrap.appendChild(head);

		if (s.busy) {
			let t = C.el(doc, "div", "annota-thinking");
			let dots = C.el(doc, "span", "annota-dots");
			for (let k = 0; k < 3; k++) dots.appendChild(C.el(doc, "span"));
			t.appendChild(dots);
			t.appendChild(C.el(doc, "span", null, Annota.t("sp.checking", { n: s.targets.length })));
			wrap.appendChild(t);
			return wrap;
		}
		if (s.error) {
			let err = C.el(doc, "div", "annota-error");
			err.appendChild(C.el(doc, "div", null, s.error));
			wrap.appendChild(err);
			return wrap;
		}

		let open = 0, fixed = 0;
		for (let t of s.targets) {
			for (let x of t.issues || []) {
				if (x.state === "open") open++;
				else if (x.state === "fixed") fixed++;
			}
		}
		let summary = C.el(doc, "div", "annota-spell-summary");
		summary.appendChild(C.el(doc, "span", null, open
			? Annota.t("sp.summary", { n: open, m: s.targets.length })
			: Annota.t("sp.clean", { m: s.targets.length })
				+ (fixed ? " " + Annota.t("sp.fixedcount", { n: fixed }) : "")));
		let fixable = s.targets.some(t => (t.issues || []).some(x => x.state === "open" && x.suggestions.length));
		if (fixable) {
			let all = C.button(doc, Annota.t("sp.all"), "annota-launch annota-spell-all", async () => {
				all.disabled = true;
				let r = await this.applyAll(s);
				if (r.failed) toast("Annota", Annota.t("sp.err.some", { n: r.failed }), "error");
				C.renderInstance(inst);
			});
			all.setAttribute("title", Annota.t("sp.all.title"));
			summary.appendChild(all);
		}
		wrap.appendChild(summary);

		for (let t of s.targets) {
			let issues = (t.issues || []).filter(x => x.state !== "stale");
			if (!issues.length) continue;
			wrap.appendChild(this.renderTarget(inst, t, issues));
		}
		return wrap;
	},

	renderTarget(inst, t, issues) {
		let C = AnnotaChat, doc = inst.doc;
		let card = C.el(doc, "div", "annota-spell-card");
		let head = C.el(doc, "div", "annota-spell-card-head");
		if (t.kind === "annotation") {
			let mark = C.el(doc, "span", "annota-spell-mark");
			mark.style.background = t.color || "#ffd400";
			head.appendChild(mark);
			head.appendChild(C.el(doc, "span", "annota-spell-where",
				(t.page ? "p. " + t.page + " · " : "") + (t.quote ? "« " + t.quote.slice(0, 60)
					+ (t.quote.length > 60 ? "…" : "") + " »" : Annota.t("sp.annotation"))));
			head.setAttribute("title", Annota.t("sp.show"));
			head.addEventListener("click", () => this.reveal(t));
		}
		else {
			head.appendChild(C.icon(doc, "note", 13));
			head.appendChild(C.el(doc, "span", "annota-spell-where", t.title || Annota.t("sp.note")));
		}
		card.appendChild(head);
		for (let x of issues) card.appendChild(this.renderIssue(inst, t, x));
		return card;
	},

	// Extrait autour de la faute, la faute marquée.
	context(text, start, length) {
		let a = Math.max(0, start - 45), b = Math.min(text.length, start + length + 45);
		let before = text.slice(a, start), after = text.slice(start + length, b);
		before = before.slice(Math.max(0, before.lastIndexOf("\n") + 1));
		// Extrait coupé : on repart au mot suivant plutôt qu'au milieu d'un mot.
		if (a > 0 && !text.slice(a, start).includes("\n")) {
			let sp = before.search(/\s/);
			if (sp >= 0 && sp < before.length - 1) before = before.slice(sp + 1);
		}
		let nl = after.indexOf("\n");
		if (nl >= 0) after = after.slice(0, nl);
		return { before: (a > 0 && !text.slice(a, start).includes("\n") ? "…" : "") + before,
			word: text.slice(start, start + length),
			after: after + (b < text.length && nl < 0 ? "…" : "") };
	},

	renderIssue(inst, t, x) {
		let C = AnnotaChat, doc = inst.doc;
		let row = C.el(doc, "div", "annota-spell-issue");
		row.setAttribute("data-state", x.state);
		let kind = C.el(doc, "span", "annota-spell-kind annota-spell-" + x.type,
			Annota.t(x.type === "grammar" ? "sp.grammar" : "sp.spelling"));
		let line = C.el(doc, "div", "annota-spell-line");
		line.appendChild(kind);
		let ctx = C.el(doc, "span", "annota-spell-ctx");
		if (x.state === "fixed") {
			let c = this.context(t.vis.text, x.start, x.applied.length);
			ctx.appendChild(doc.createTextNode(c.before));
			ctx.appendChild(C.el(doc, "ins", null, c.word));
			ctx.appendChild(doc.createTextNode(c.after));
		}
		else {
			let c = this.context(t.vis.text, x.start, x.length);
			ctx.appendChild(doc.createTextNode(c.before));
			ctx.appendChild(C.el(doc, "mark", null, c.word));
			ctx.appendChild(doc.createTextNode(c.after));
		}
		line.appendChild(ctx);
		row.appendChild(line);
		if (x.message && x.state === "open") row.appendChild(C.el(doc, "div", "annota-spell-msg", x.message));
		if (x.state !== "open") {
			row.appendChild(C.el(doc, "div", "annota-spell-msg",
				Annota.t(x.state === "fixed" ? "sp.fixed" : "sp.ignored")));
			return row;
		}

		let acts = C.el(doc, "div", "annota-spell-acts");
		for (let sug of x.suggestions) {
			acts.appendChild(C.button(doc, sug, "annota-spell-sug", async () => {
				try { await this.apply(t, x, sug); }
				catch (e) { toast("Annota", String(e.message || e), "error"); }
				C.renderInstance(inst);
			}, Annota.t("sp.replace", { w: sug })));
		}
		if (!x.suggestions.length) {
			acts.appendChild(C.el(doc, "span", "annota-spell-nosug", Annota.t("sp.nosug")));
		}
		acts.appendChild(C.button(doc, Annota.t("sp.ignore"), "annota-link-btn annota-spell-ign", () => {
			x.state = "ignored";
			C.renderInstance(inst);
		}));
		if (x.type === "spelling") {
			acts.appendChild(C.button(doc, Annota.t("sp.learn"), "annota-link-btn annota-spell-ign", async () => {
				try {
					await this.learn(x.word);
					// Le mot appris disparaît partout dans la revue.
					for (let tt of inst.spell.targets) {
						for (let y of tt.issues || []) {
							if (y.type === "spelling" && y.word === x.word && y.state === "open") y.state = "ignored";
						}
					}
				}
				catch (e) { toast("Annota", String(e.message || e), "error"); }
				C.renderInstance(inst);
			}, Annota.t("sp.learn.title")));
		}
		row.appendChild(acts);
		return row;
	},

	// Montre l'annotation dans son PDF, s'il est ouvert ou ouvrable.
	reveal(t) {
		try {
			let ann = Zotero.Items.get(t.id);
			let att = ann && ann.parentItem;
			if (!att) return;
			Zotero.Reader.open(att.id, { annotationID: ann.key })
				.catch(e => log("orthographe, ouverture : " + e));
		}
		catch (e) { log("orthographe, ouverture : " + e); }
	},

	// Styles de la vue, ajoutés à ceux du panneau.
	CSS: `
.annota-spell { display: flex; flex-direction: column; gap: 10px; }
.annota-spell-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.annota-spell-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px; font-size: 12px; color: var(--fill-secondary); }
.annota-spell-card { display: flex; flex-direction: column; overflow: hidden; border-radius: 8px;
  border: 1px solid var(--fill-quarternary, rgba(128,128,128,.3)); background: var(--material-background, Field); }
.annota-spell-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 10px;
  border-bottom: 1px solid var(--fill-quinary, rgba(128,128,128,.2)); font-size: 11.5px;
  color: var(--fill-secondary); cursor: default; }
.annota-spell-card-head[title] { cursor: pointer; }
.annota-spell-mark { flex: none; width: 10px; height: 10px; border-radius: 2px; }
.annota-spell-where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annota-spell-issue { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; }
.annota-spell-issue + .annota-spell-issue { border-top: 1px solid var(--fill-quinary, rgba(128,128,128,.2)); }
.annota-spell-issue[data-state="fixed"], .annota-spell-issue[data-state="ignored"] { opacity: .6; }
.annota-spell-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; line-height: 1.45; }
.annota-spell-kind { flex: none; padding: 0 6px; border-radius: 4px; font-size: 10.5px; font-weight: 600; }
.annota-spell-spelling { background: #ff66661a; color: #e5484d; }
.annota-spell-grammar { background: #2ea8e51a; color: #1f8bc4; }
.annota-spell-ctx { min-width: 0; overflow-wrap: anywhere; }
.annota-spell-ctx mark { background: none; color: inherit; text-decoration: underline wavy #e5484d;
  text-decoration-skip-ink: none; text-underline-offset: 3px; }
.annota-spell-grammar + .annota-spell-ctx mark { text-decoration-color: #2ea8e5; }
.annota-spell-ctx ins { text-decoration: none; background: #22c55e1f; border-radius: 3px; padding: 0 2px; }
.annota-spell-msg { font-size: 11.5px; color: var(--fill-secondary); }
.annota-spell-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.annota-spell-sug { appearance: none; padding: 2px 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--fill-quarternary, rgba(128,128,128,.35)); background: var(--material-sidepane, Field);
  color: var(--fill-primary, inherit); font-size: 12px; }
.annota-spell-sug:hover { border-color: #22c55e; }
.annota-spell-nosug { font-size: 11.5px; color: var(--fill-tertiary); }
.annota-spell-ign { margin-left: 4px; color: var(--fill-secondary); font-size: 11.5px; }
`
};
