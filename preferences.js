/* eslint-disable no-undef */
// Script du panneau de préférences.
//
// Chaque couleur de surlignage a son propre réglage, stocké dans le JSON
// annota.colorPrompts sous la forme { "#hex": { prompt, trigger } }.
// (Rétrocompat : une ancienne valeur chaîne est lue comme trigger "auto".)
// trigger "auto"   = génère à la création du surlignage.
// trigger "manual" = uniquement via le menu contextuel.
// Une couleur sans prompt n'est jamais traitée. On sauvegarde toujours AVANT
// de changer de couleur.

(function () {
	// Le panneau est construit par Zotero de façon asynchrone : on réessaie
	// jusqu'à ce que les éléments existent. Mais BORNÉ — un panneau refermé
	// avant la fin laissait sinon une boucle d'animation tourner sur un
	// document détruit (« can't access dead object » dans la console).
	const MAX_RETRIES = 120;   // ~2 s à 60 images/s
	function retry(fn, tries) {
		if ((tries || 0) >= MAX_RETRIES) return;
		requestAnimationFrame(() => {
			try { fn((tries || 0) + 1); }
			catch (e) { /* document fermé entre-temps */ }
		});
	}

	const PREF_COLORS = "annota.colorPrompts";
	const PREF_PROVIDER = "annota.provider";
	const XHTML_NS = "http://www.w3.org/1999/xhtml";

	function api() {
		try { return Zotero.Annota || null; }
		catch (e) { return null; }
	}

	function T(key, vars) {
		let a = api();
		return a && typeof a.t === "function" ? a.t(key, vars) : key;
	}

	// Fonctions à rejouer quand la langue change (textes construits par code).
	const relocalizers = [];

	// Texte traduit → nœuds, sans innerHTML : seules <b>, <i>, <code> sont
	// reconnues, le reste est du texte.
	function fillMarkup(el, str) {
		el.textContent = "";
		let stack = [el];
		for (let part of String(str).split(/(<\/?(?:b|i|code)>)/)) {
			let m = part.match(/^<(\/?)(b|i|code)>$/);
			if (!m) {
				if (part) stack[stack.length - 1].appendChild(document.createTextNode(part));
			}
			else if (!m[1]) {
				let n = document.createElementNS(XHTML_NS, m[2]);
				stack[stack.length - 1].appendChild(n);
				stack.push(n);
			}
			else if (stack.length > 1) stack.pop();
		}
	}

	// L'anglais est le texte d'origine du panneau : on le mémorise avant de
	// le remplacer, pour pouvoir y revenir sans recharger.
	const original = new WeakMap();
	function applyI18n() {
		let a = api();
		let lang = a && typeof a.lang === "function" ? a.lang() : "en";
		let dict = (a && a.i18n && a.i18n[lang]) || {};
		let root = document.getElementById("annota-prefs");
		if (root) root.setAttribute("lang", lang);
		for (let el of document.querySelectorAll("[data-i18n]")) {
			if (!original.has(el)) {
				original.set(el, Array.from(el.childNodes).map(n => n.cloneNode(true)));
			}
			let key = el.getAttribute("data-i18n");
			if (lang !== "en" && dict[key] != null) fillMarkup(el, dict[key]);
			else {
				el.textContent = "";
				for (let n of original.get(el)) el.appendChild(n.cloneNode(true));
			}
		}
		for (let el of document.querySelectorAll("[data-i18n-ph]")) {
			if (!el.hasAttribute("data-ph-en")) {
				el.setAttribute("data-ph-en", el.getAttribute("placeholder") || "");
			}
			let key = el.getAttribute("data-i18n-ph");
			el.setAttribute("placeholder", lang !== "en" && dict[key] != null
				? dict[key] : el.getAttribute("data-ph-en"));
		}
	}

	function relocalize() {
		applyI18n();
		for (let fn of relocalizers) {
			try { fn(); } catch (e) { /* panneau en cours de fermeture */ }
		}
	}

	function colors() {
		let a = api();
		return (a && Array.isArray(a.COLORS)) ? a.COLORS : [];
	}

	// Normalise une valeur brute en { prompt, trigger, template }.
	// Une couleur est active si elle a un prompt OU un gabarit (un gabarit sans
	// {{ai}} produit un commentaire déterministe, sans appel à l'IA).
	function normalize(raw) {
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
		// Un libellé seul n'active pas une couleur (voir getColorEntry) : il la
		// nomme, il ne la configure pas.
		if (!prompt.trim() && !template.trim() && !fields.trim()) return null;
		return {
			prompt,
			template,
			fields,
			label: String(raw.label || "").trim(),
			trigger: raw.trigger === "manual" ? "manual" : "auto"
		};
	}

	function readColorMap() {
		try {
			let raw = String(Zotero.Prefs.get(PREF_COLORS) || "").trim();
			if (!raw) return {};
			let obj = JSON.parse(raw);
			return (obj && typeof obj === "object") ? obj : {};
		}
		catch (e) {
			return {};
		}
	}

	function writeColorMap(map) {
		// Ne conserver que les entrées ayant un prompt non vide.
		let clean = {};
		for (let k of Object.keys(map)) {
			let n = normalize(map[k]);
			if (n) clean[k] = n;
		}
		Zotero.Prefs.set(PREF_COLORS, Object.keys(clean).length ? JSON.stringify(clean) : "");
	}

	// Onglets. Boutons HTML + bascule de l'attribut hidden : même mécanique que
	// le sélecteur de fournisseur ci-dessous, qui fonctionne déjà. Si le script
	// échoue, tous les panneaux restent visibles plutôt qu'inaccessibles.
	function setupTabs(tries) {
		let bar = document.getElementById("annota-tabs");
		let panes = {
			colors: document.getElementById("annota-pane-colors"),
			ai: document.getElementById("annota-pane-ai"),
			chat: document.getElementById("annota-pane-chat"),
			general: document.getElementById("annota-pane-general")
		};
		if (!bar || !panes.colors || !panes.ai || !panes.chat || !panes.general) {
			retry(setupTabs, tries);
			return;
		}

		let tabs = Array.from(bar.querySelectorAll(".annota-tab"));
		if (!tabs.length) return;

		// Fond de la zone fixée en haut : celui du premier ancêtre opaque,
		// pour qu'elle se fonde dans la fenêtre au lieu de former une bande.
		try {
			let view = bar.ownerDocument.defaultView;
			for (let n = bar.parentElement; n; n = n.parentElement) {
				let c = view.getComputedStyle(n).backgroundColor;
				if (c && c !== "transparent" && !/,\s*0\)$/.test(c)) {
					bar.style.setProperty("--annota-page-bg", c);
					break;
				}
			}
		}
		catch (e) { /* fond transparent : sans conséquence */ }

		function apply(name) {
			for (let key of Object.keys(panes)) panes[key].hidden = (key !== name);
			for (let t of tabs) {
				let on = t.getAttribute("data-pane") === name;
				t.setAttribute("data-active", on ? "true" : "false");
				t.setAttribute("aria-selected", on ? "true" : "false");
				t.setAttribute("tabindex", on ? "0" : "-1");
			}
			let a = api();
			if (a) a._prefsTab = name;
		}

		for (let t of tabs) {
			t.addEventListener("click", () => apply(t.getAttribute("data-pane")));
			// Flèches gauche/droite : d'un onglet à l'autre, comme un tablist.
			t.addEventListener("keydown", (e) => {
				if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
				e.preventDefault();
				let i = tabs.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1);
				let next = tabs[(i + tabs.length) % tabs.length];
				next.focus();
				apply(next.getAttribute("data-pane"));
			});
		}
		// Rouvrir les réglages ramène au dernier onglet consulté.
		let a = api();
		let last = a && a._prefsTab;
		apply(panes[last] ? last : "colors");
	}

	// Sélecteur de fournisseur : n'affiche que les réglages du fournisseur actif.
	// La pref est écrite à la main (un <select> n'a pas de binding « preference »).
	function setupProvider(tries) {
		let sel = document.getElementById("annota-provider");
		let panes = {
			openai: document.getElementById("annota-cfg-openai"),
			ollama: document.getElementById("annota-cfg-ollama"),
			apple: document.getElementById("annota-cfg-apple"),
			cli: document.getElementById("annota-cfg-cli")
		};
		if (!sel || !panes.openai || !panes.ollama || !panes.apple || !panes.cli) {
			retry(setupProvider, tries);
			return;
		}

		function current() {
			let p = String(Zotero.Prefs.get(PREF_PROVIDER) || "").trim();
			if (p === "openai" || p === "ollama" || p === "cli" || p === "apple") return p;
			// Rétrocompat avec l'ancienne case à cocher.
			return Zotero.Prefs.get("annota.useClaudeCLI") ? "cli" : "openai";
		}

		function apply(p) {
			for (let key of Object.keys(panes)) panes[key].hidden = (key !== p);
		}

		sel.value = current();
		apply(sel.value);
		sel.addEventListener("change", () => {
			Zotero.Prefs.set(PREF_PROVIDER, sel.value);
			apply(sel.value);
		});
	}

	// ---- Modèles Ollama : liste réelle des modèles installés ----
	// Évite l'échec « model not found » : les tags comptent (llama3.1:8b).
	function setupOllama(tries) {
		let sel = document.getElementById("annota-ollama-model");
		let btn = document.getElementById("annota-ollama-refresh");
		let status = document.getElementById("annota-ollama-status");
		if (!sel || !btn) {
			retry(setupOllama, tries);
			return;
		}

		const PREF_MODEL = "annota.ollamaModel";
		const PREF_ENDPOINT = "annota.ollamaEndpoint";

		function stored() {
			return String(Zotero.Prefs.get(PREF_MODEL) || "").trim();
		}

		// http://host:11434/v1/chat/completions → http://host:11434/api/tags
		function tagsURL() {
			let ep = String(Zotero.Prefs.get(PREF_ENDPOINT) || "").trim();
			if (!ep) return "http://localhost:11434/api/tags";
			return ep.replace(/\/v1\/.*$/, "") .replace(/\/+$/, "") + "/api/tags";
		}

		function setStatus(msg) {
			if (status) status.textContent = msg || "";
		}

		function fill(names) {
			let keep = stored();
			// Toujours conserver la valeur enregistrée, même absente d'Ollama,
			// pour ne pas l'effacer silencieusement.
			if (keep && !names.includes(keep)) names = [keep].concat(names);
			sel.textContent = "";
			for (let n of names) {
				let opt = document.createElementNS(XHTML_NS, "option");
				opt.setAttribute("value", n);
				opt.textContent = n;
				sel.appendChild(opt);
			}
			if (keep) sel.value = keep;
			else if (names.length) {
				sel.value = names[0];
				Zotero.Prefs.set(PREF_MODEL, names[0]);
			}
		}

		async function refresh() {
			setStatus("…");
			try {
				let resp = await Zotero.HTTP.request("GET", tagsURL(),
					{ responseType: "json", timeout: 5000 });
				let models = (resp.response && resp.response.models) || [];
				let names = models.map(m => m && m.name).filter(Boolean);
				fill(names);
				setStatus(names.length
					? T("p.ollama.count", { n: names.length })
					: T("p.ollama.none"));
			}
			catch (e) {
				fill([]);
				setStatus(T("p.ollama.unreachable"));
			}
		}

		sel.addEventListener("change", () => {
			Zotero.Prefs.set(PREF_MODEL, sel.value);
			setStatus(T("p.saved"));
		});
		btn.addEventListener("click", refresh);

		fill([]);        // afficher au moins la valeur enregistrée
		refresh();       // puis interroger Ollama
	}

	// Diagnostic du schéma : parseFieldSchema se tait et continue à l'exécution
	// — c'est le bon comportement là-bas. Ici, il faut dire ce qui sera ignoré,
	// sinon un champ nommé « page » disparaît sans que rien ne l'annonce.
	function renderLint(box, entry) {
		if (!box) return;
		let a = api();
		let problems = (a && typeof a.lintColorEntry === "function")
			? a.lintColorEntry(entry) : [];
		box.textContent = "";
		if (!problems.length) {
			box.hidden = true;
			box.removeAttribute("data-worst");
			return;
		}
		box.hidden = false;
		box.setAttribute("data-worst",
			problems.some(p => p.level === "error") ? "error" : "warn");
		for (let p of problems) {
			let row = document.createElementNS(XHTML_NS, "p");
			if (p.line) {
				let where = document.createElementNS(XHTML_NS, "span");
				where.setAttribute("class", "annota-lint-line");
				where.textContent = T("p.lint.line", { n: p.line });
				row.appendChild(where);
			}
			let icon = document.createElementNS(XHTML_NS, "span");
			icon.textContent = (p.level === "error" ? "⚠ " : "· ");
			row.appendChild(icon);
			row.appendChild(document.createTextNode(p.message));
			box.appendChild(row);
		}
	}

	// ---- Éditeur visuel des champs ----
	//
	// La préférence reste le texte « nom | Libellé | type | options | format »
	// lu par parseFieldSchema : l'éditeur le relit et le réécrit, si bien que
	// les réglages existants restent valides et que le mode texte demeure
	// disponible pour qui le préfère. Ce que l'éditeur ne sait pas montrer
	// (lignes de commentaire, nom réservé ou absent) le fait rester en mode
	// texte plutôt que de le perdre.

	const FIELD_TYPES = ["text", "textarea", "check", "select", "ai"];
	const FIELD_FORMATS = [
		["plain", "Aa"], ["bold", "B"], ["italic", "I"], ["bolditalic", "BI"], ["underline", "U"]
	];
	// Modèles de départ, dans la langue de l'interface. Les noms de variables
	// restent fixes : un prompt qui s'y réfère marche dans les deux langues.
	function fieldPresets() {
		return [
			{ label: T("fe.preset.1"), rows: [
				{ name: "heading", label: T("fe.preset.1.a"), type: "text", format: "bold" },
				{ name: "paraphrase", label: T("fe.preset.1.b"), type: "textarea", format: "plain" },
				{ name: "source", label: T("fe.preset.1.c"), type: "text", format: "italic" }] },
			{ label: T("fe.preset.2"), rows: [
				{ name: "concept", label: T("fe.preset.2.a"), type: "text", format: "bold" },
				{ name: "definition", label: T("fe.preset.2.b"), type: "textarea", format: "plain" }] },
			{ label: T("fe.preset.3"), rows: [
				{ name: "note", label: T("fe.preset.3.a"), type: "textarea", format: "plain" },
				{ name: "kind", label: T("fe.preset.3.b"), type: "select",
					options: T("fe.preset.3.opts"), format: "italic" }] }
		];
	}

	function el(tag, cls, text) {
		let e = document.createElementNS(XHTML_NS, tag);
		if (cls) e.setAttribute("class", cls);
		if (text != null) e.textContent = text;
		return e;
	}

	function btn(label, cls, title, onClick) {
		let b = el("button", cls, label);
		b.setAttribute("type", "button");
		if (title) {
			b.setAttribute("title", title);
			b.setAttribute("aria-label", title);
		}
		b.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
		return b;
	}

	// « Référence indirecte » → reference_indirecte. Un nom réservé
	// ({{title}}, {{page}}…) prend un préfixe plutôt que d'être ignoré.
	function slug(label, a) {
		let s = String(label || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
			.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
		if (!s) s = "field";
		if (/^\d/.test(s)) s = "f_" + s;
		let reserved = (a && a.RESERVED_VARS) || [];
		if (reserved.includes(s)) s = "my_" + s;
		return s;
	}

	// Chevron dessiné : les flèches Unicode passent en emoji colorées sur
	// certains systèmes.
	function chevron(up) {
		const SVG = "http://www.w3.org/2000/svg";
		let svg = document.createElementNS(SVG, "svg");
		svg.setAttribute("viewBox", "0 0 12 12");
		svg.setAttribute("width", "10");
		svg.setAttribute("height", "10");
		svg.setAttribute("aria-hidden", "true");
		let path = document.createElementNS(SVG, "path");
		path.setAttribute("d", up ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5");
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "1.6");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		svg.appendChild(path);
		return svg;
	}

	function cleanCell(s) {
		return String(s || "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim();
	}

	function createFieldEditor({ host, textarea, templateArea, onChange, onCommit }) {
		let a = api();
		let rows = [];
		// preferred : le choix de l'utilisateur ; mode : ce qui est affiché
		// (le texte s'impose pour une couleur que l'éditeur ne sait pas lire).
		let preferred = (a && a._fieldsMode) || "visual";
		let mode = preferred;

		let list = el("div", "annota-fe-list");
		let empty = el("div", "annota-fe-empty");
		let addBar = el("div", "annota-fe-addbar");
		let preview = el("div", "annota-fe-preview");
		let notice = el("p", "annota-fe-notice");
		let toggle = btn("", "annota-link", "", () => {
			preferred = mode === "visual" ? "text" : "visual";
			if (a) a._fieldsMode = preferred;
			setMode(preferred);
		});
		let visual = el("div", "annota-fe");
		visual.appendChild(list);
		visual.appendChild(empty);
		visual.appendChild(addBar);
		visual.appendChild(preview);
		host.appendChild(visual);
		host.appendChild(notice);
		let foot = el("div", "annota-fe-foot");
		foot.appendChild(toggle);
		host.appendChild(foot);

		let addBtn = btn(T("fe.add"), "annota-button annota-fe-add", T("fe.add.title"), () => {
			let base = T("fe.base", { n: rows.length + 1 });
			rows.push({ name: uniqueName(slug(base, a)), label: base, type: "text",
				format: "plain", options: "", prompt: "", nameEdited: false });
			write(true);
			render();
			let inputs = list.querySelectorAll(".annota-fe-label");
			let last = inputs[inputs.length - 1];
			if (last) { last.focus(); last.select(); }
		});
		addBar.appendChild(addBtn);

		function uniqueName(base, except) {
			let taken = new Set(rows.filter(r => r !== except).map(r => r.name));
			if (!taken.has(base)) return base;
			for (let i = 2; ; i++) if (!taken.has(base + i)) return base + i;
		}

		// Lignes que parseFieldSchema ignorerait, ou commentaires : le
		// mode visuel les perdrait.
		function unsupported(text) {
			let lines = String(text || "").split("\n").map(l => l.trim()).filter(Boolean);
			if (lines.some(l => l.startsWith("#"))) return true;
			return a ? a.parseFieldSchema(text).length !== lines.length : false;
		}

		function parse(text) {
			if (!a) return [];
			return a.parseFieldSchema(text).map(f => ({
				name: f.name,
				label: f.label,
				type: f.type,
				format: f.format || "plain",
				options: (f.options || []).join(", "),
				prompt: f.prompt || "",
				nameEdited: f.name !== slug(f.label, a)
			}));
		}

		function serialize() {
			return rows.map(r => {
				let cols = [r.name, cleanCell(r.label) || r.name, r.type];
				let fmt = r.format && r.format !== "plain" ? r.format : "";
				if (r.type === "select") { cols.push(cleanCell(r.options)); if (fmt) cols.push(fmt); }
				else if (r.type === "ai") { cols.push(cleanCell(r.prompt)); if (fmt) cols.push(fmt); }
				else if (fmt) cols.push(fmt);
				return cols.join(" | ");
			}).join("\n");
		}

		// commit : changement de structure, enregistré tout de suite ; sinon
		// une frappe, enregistrée après une pause (onChange).
		function write(commit) {
			textarea.value = serialize();
			renderPreview();
			if (commit) onCommit(); else onChange();
		}

		function renderPreview() {
			preview.textContent = "";
			if (!rows.length) { preview.hidden = true; return; }
			preview.hidden = false;
			preview.appendChild(el("div", "annota-fe-preview-title", T("fe.preview")));
			let body = el("div", "annota-fe-preview-body");
			if (templateArea && templateArea.value.trim()) {
				body.appendChild(el("span", "annota-help", T("fe.preview.layout")));
			}
			else {
				for (let r of rows) {
					let sample = r.type === "check" ? "✓ " + (r.label || r.name)
						: r.type === "select" ? (r.options.split(",")[0] || "").trim() || r.label
						: r.type === "ai" ? "⟨AI: " + (r.prompt || "instruction") + "⟩"
						: r.label || r.name;
					let line = el("div");
					let node = line;
					if (r.format === "bold" || r.format === "bolditalic") {
						let b = el("b"); node.appendChild(b); node = b;
					}
					if (r.format === "italic" || r.format === "bolditalic") {
						let i = el("i"); node.appendChild(i); node = i;
					}
					if (r.format === "underline") {
						let u = el("u"); node.appendChild(u); node = u;
					}
					node.textContent = sample;
					if (r.type === "ai") line.setAttribute("class", "annota-fe-preview-ai");
					body.appendChild(line);
				}
			}
			preview.appendChild(body);
		}

		function renderRow(r, i) {
			let row = el("div", "annota-fe-row");
			row.setAttribute("data-type", r.type);

			let move = el("div", "annota-fe-move");
			let up = btn("", "annota-fe-icon", T("fe.up"), () => {
				[rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
				write(true); render();
			});
			let down = btn("", "annota-fe-icon", T("fe.down"), () => {
				[rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
				write(true); render();
			});
			up.appendChild(chevron(true));
			down.appendChild(chevron(false));
			up.disabled = i === 0;
			down.disabled = i === rows.length - 1;
			move.appendChild(up);
			move.appendChild(down);

			let label = el("input", "annota-input annota-fe-label");
			label.setAttribute("type", "text");
			label.setAttribute("placeholder", T("fe.label.ph"));
			label.setAttribute("aria-label", T("fe.label.aria"));
			label.value = r.label;

			let type = el("select", "annota-input annota-fe-type");
			type.setAttribute("aria-label", T("fe.type.aria"));
			for (let v of FIELD_TYPES) {
				let o = el("option", null, T("fe.type." + v));
				o.setAttribute("value", v);
				type.appendChild(o);
			}
			type.value = r.type;

			let fmt = el("div", "annota-fe-format");
			fmt.setAttribute("role", "group");
			fmt.setAttribute("aria-label", T("fe.fmt.aria"));
			for (let [v, txt] of FIELD_FORMATS) {
				let f = btn(txt, "annota-fe-fmt annota-fe-fmt-" + v, T("fe.fmt." + v), () => {
					r.format = v;
					for (let x of fmt.children) {
						x.setAttribute("aria-pressed", x === f ? "true" : "false");
					}
					write(true);
				});
				f.setAttribute("aria-pressed", r.format === v ? "true" : "false");
				fmt.appendChild(f);
			}

			let del = btn("×", "annota-fe-icon annota-fe-del", T("fe.remove"), () => {
				rows.splice(i, 1);
				write(true); render();
			});

			row.appendChild(move);
			row.appendChild(label);
			row.appendChild(type);
			row.appendChild(fmt);
			row.appendChild(del);

			// Selon le type : choix proposés, ou consigne du modèle.
			if (r.type === "select") {
				let opts = el("input", "annota-input annota-fe-extra");
				opts.setAttribute("type", "text");
				opts.setAttribute("placeholder", T("fe.choices.ph"));
				opts.setAttribute("aria-label", T("fe.choices.aria"));
				opts.value = r.options;
				opts.addEventListener("input", () => { r.options = opts.value; write(false); });
				row.appendChild(opts);
			}
			else if (r.type === "ai") {
				let pr = el("textarea", "annota-input annota-fe-extra");
				pr.setAttribute("rows", "2");
				pr.setAttribute("placeholder", T("fe.ai.ph"));
				pr.setAttribute("aria-label", T("fe.ai.aria"));
				pr.value = r.prompt;
				pr.addEventListener("input", () => { r.prompt = pr.value; write(false); });
				row.appendChild(pr);
			}

			// Nom de variable : déduit du libellé tant qu'on ne l'a pas modifié.
			let varLine = el("label", "annota-fe-var");
			varLine.appendChild(el("span", null, T("fe.var")));
			let open = el("code", null, "{{");
			let name = el("input", "annota-fe-name");
			name.setAttribute("type", "text");
			name.setAttribute("aria-label", T("fe.var.aria"));
			name.setAttribute("spellcheck", "false");
			name.value = r.name;
			let fit = () => { name.style.width = (Math.max(3, name.value.length) + 1) + "ch"; };
			fit();
			let close = el("code", null, "}}");
			varLine.appendChild(open);
			varLine.appendChild(name);
			varLine.appendChild(close);
			row.appendChild(varLine);

			label.addEventListener("input", () => {
				r.label = label.value;
				if (!r.nameEdited) {
					r.name = uniqueName(slug(r.label, a), r);
					name.value = r.name;
					fit();
				}
				write(false);
			});
			name.addEventListener("input", () => {
				let v = name.value.replace(/[^\w]/g, "");
				if (v !== name.value) name.value = v;
				fit();
				let reserved = a && a.RESERVED_VARS && a.RESERVED_VARS.includes(v);
				name.setAttribute("data-invalid", !v || reserved ? "true" : "false");
				name.setAttribute("title", reserved ? T("fe.var.reserved", { v })
					: !v ? T("fe.var.required") : "");
				if (!v || reserved) return;
				r.name = v;
				r.nameEdited = v !== slug(r.label, a);
				write(false);
			});
			type.addEventListener("change", () => {
				r.type = type.value;
				write(true);
				render();
			});
			return row;
		}

		function render() {
			list.textContent = "";
			rows.forEach((r, i) => list.appendChild(renderRow(r, i)));
			empty.textContent = "";
			empty.hidden = rows.length > 0;
			if (!rows.length) {
				empty.appendChild(el("span", "annota-help", T("fe.empty")));
				let chips = el("div", "annota-fe-presets");
				for (let p of fieldPresets()) {
					chips.appendChild(btn(p.label, "annota-fe-preset", T("fe.preset.title"), () => {
						rows = p.rows.map(x => Object.assign(
							{ options: "", prompt: "", nameEdited: true }, x));
						write(true);
						render();
					}));
				}
				empty.appendChild(chips);
			}
			renderPreview();
		}

		function setMode(m, silent) {
			if (m === "visual" && unsupported(textarea.value)) {
				m = "text";
				notice.textContent = T("fe.notice");
				notice.hidden = false;
			}
			else notice.hidden = true;
			if (m === "visual" && !silent) {
				rows = parse(textarea.value);
				render();
			}
			mode = m;
			visual.hidden = m !== "visual";
			textarea.hidden = m === "visual";
			toggle.textContent = T(m === "visual" ? "fe.astext" : "fe.visual");
		}

		// Couleur chargée, effacée, ou texte modifié ailleurs.
		function refresh() {
			rows = parse(textarea.value);
			render();
			setMode(preferred, true);
		}

		if (templateArea) templateArea.addEventListener("input", renderPreview);
		refresh();
		relocalizers.push(() => {
			addBtn.textContent = T("fe.add");
			addBtn.setAttribute("title", T("fe.add.title"));
			render();
			setMode(mode, true);
		});
		return { refresh };
	}

	function setup(tries) {
		let textarea = document.getElementById("annota-prompt");
		let clearBtn = document.getElementById("annota-prompt-clear");
		let status = document.getElementById("annota-prompt-status");
		let swatchBox = document.getElementById("annota-swatches");
		let targetName = document.getElementById("annota-target-name");
		let idleWarning = document.getElementById("annota-idle-warning");
		let triggerRadios = Array.from(
			document.querySelectorAll('input[name="annota-trigger"]'));
		let templateArea = document.getElementById("annota-template");
		let fieldsArea = document.getElementById("annota-fields");
		let lintBox = document.getElementById("annota-lint");
		let labelInput = document.getElementById("annota-label");
		let editorHost = document.getElementById("annota-fields-editor");
		if (!textarea || !swatchBox || triggerRadios.length < 2 || !templateArea || !fieldsArea
				|| !labelInput) {
			retry(setup, tries);
			return;
		}

		let palette = colors();
		if (!palette.length) {
			retry(setup, tries);
			return;
		}

		// Couleur en cours d'édition.
		let current = palette[0].hex;

		let flashTimer = null;
		function flashStatus(msg) {
			if (!status) return;
			status.textContent = msg;
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => { status.textContent = ""; }, 2000);
		}

		function currentTrigger() {
			let on = triggerRadios.find(r => r.checked);
			return on && on.value === "manual" ? "manual" : "auto";
		}

		function setTrigger(v) {
			for (let r of triggerRadios) r.checked = (r.value === (v === "manual" ? "manual" : "auto"));
		}

		function save() {
			let map = readColorMap();
			let prompt = textarea.value;
			let template = templateArea.value;
			let fields = fieldsArea.value;
			// Actif si prompt OU gabarit OU champs.
			if ((prompt && prompt.trim()) || (template && template.trim())
					|| (fields && fields.trim())) {
				map[current] = { prompt, template, fields,
					label: String(labelInput.value || "").trim(),
					trigger: currentTrigger() };
			}
			else {
				delete map[current];
			}
			writeColorMap(map);
			flashStatus(T("p.saved"));
			refreshSwatches();
		}

		// Tout le réglage des couleurs tient dans UNE préférence JSON de plusieurs
		// kilo-octets, et Zotero écrit les préférences sur disque : sauvegarder à
		// la frappe réécrivait le bloc entier toutes les demi-secondes (Firefox
		// s'en plaint dans la console). On attend donc une vraie pause de frappe,
		// la sortie du champ ou le changement de couleur, qui eux forcent
		// l'enregistrement immédiat.
		function lintNow() {
			renderLint(lintBox, {
				fields: fieldsArea.value,
				prompt: textarea.value,
				template: templateArea.value
			});
		}

		let saveTimer = null;
		function scheduleSave() {
			// Le diagnostic est immédiat, l'enregistrement non : on veut voir
			// « page est réservé » en tapant, pas 2,5 s plus tard.
			lintNow();
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(save, 2500);
		}
		function saveNow() {
			if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
			save();
		}

		function load(hex) {
			current = hex;
			let entry = normalize(readColorMap()[hex]);
			textarea.value = entry ? entry.prompt : "";
			templateArea.value = entry ? (entry.template || "") : "";
			fieldsArea.value = entry ? (entry.fields || "") : "";
			labelInput.value = entry ? (entry.label || "") : "";
			setTrigger(entry ? entry.trigger : "auto");
			lintNow();
			if (editor) editor.refresh();
			if (targetName) {
				let c = palette.find(x => x.hex === hex);
				targetName.textContent = c ? c.name : hex;
			}
			refreshSwatches();
		}

		// Reflète l'état des pastilles + avertissement si rien n'est configuré.
		function refreshSwatches() {
			let map = readColorMap();
			let anyPrompt = false;
			for (let el of swatchBox.children) {
				let hex = el.getAttribute("data-color");
				let name = el.getAttribute("data-name") || hex;
				let entry = normalize(map[hex]);
				if (entry) anyPrompt = true;
				el.setAttribute("data-selected", hex === current ? "true" : "false");
				el.setAttribute("data-has-prompt", entry ? "true" : "false");
				let tip = entry
					? name + (entry.label ? " · " + entry.label : "") + ": "
						+ T(entry.trigger === "manual" ? "p.sw.manual" : "p.sw.auto")
					: name + ": " + T("p.sw.inactive");
				el.setAttribute("title", tip);
			}
			if (idleWarning) idleWarning.hidden = anyPrompt;
		}

		// --- Pastilles de couleur ---
		for (let c of palette) {
			let b = document.createElementNS(XHTML_NS, "button");
			b.setAttribute("type", "button");
			b.setAttribute("class", "annota-swatch");
			b.setAttribute("data-color", c.hex);
			b.setAttribute("data-name", c.name);
			b.style.backgroundColor = c.hex;
			b.addEventListener("click", () => {
				if (current === c.hex) return;
				saveNow();          // ne pas perdre l'édition en cours
				load(c.hex);
			});
			swatchBox.appendChild(b);
		}

		// --- Textarea ---
		textarea.addEventListener("input", scheduleSave);
		textarea.addEventListener("blur", saveNow);
		templateArea.addEventListener("input", scheduleSave);
		templateArea.addEventListener("blur", saveNow);
		fieldsArea.setAttribute("placeholder", "name | Label | type | options");
		fieldsArea.addEventListener("input", scheduleSave);
		fieldsArea.addEventListener("blur", saveNow);
		labelInput.addEventListener("input", scheduleSave);
		labelInput.addEventListener("blur", saveNow);

		// --- Choix du mode (auto / manuel) ---
		// Ne sauvegarde que si la couleur a déjà un prompt (sinon rien à régler).
		for (let r of triggerRadios) {
			r.addEventListener("change", () => {
				if ((textarea.value && textarea.value.trim())
						|| (templateArea.value && templateArea.value.trim())
						|| (fieldsArea.value && fieldsArea.value.trim())) saveNow();
			});
		}

		// --- Bouton d'effacement ---
		if (clearBtn) {
			let clearColor = () => {
				let map = readColorMap();
				delete map[current];
				writeColorMap(map);
				textarea.value = "";
				templateArea.value = "";
				fieldsArea.value = "";
				labelInput.value = "";
				setTrigger("auto");
				lintNow();
				if (editor) editor.refresh();
				refreshSwatches();
				flashStatus(T("p.cleared"));
			};
			clearBtn.addEventListener("click", clearColor);
		}

		let editor = editorHost ? createFieldEditor({
			host: editorHost,
			textarea: fieldsArea,
			templateArea,
			onChange: scheduleSave,
			onCommit: () => { lintNow(); saveNow(); }
		}) : null;

		load(current);
		relocalizers.push(() => { lintNow(); refreshSwatches(); });
	}

	// ---- Discussion ----
	// Le fournisseur et les consignes sont écrits à la main, comme le
	// fournisseur des annotations : ni <select> ni <textarea> n'ont ici de
	// liaison « preference » fiable.
	function setupChat(tries) {
		let sel = document.getElementById("annota-chat-provider");
		let state = document.getElementById("annota-chat-provider-status");
		let area = document.getElementById("annota-chat-instructions");
		let status = document.getElementById("annota-chat-status");
		if (!sel || !area) {
			retry(setupChat, tries);
			return;
		}
		const PREF = "annota.chatProvider";
		const PREF_INSTR = "annota.chatInstructions";
		const KNOWN = ["openai", "ollama", "cli", "apple"];
		const NAMES = { openai: "Mistral / API", ollama: "Ollama", cli: "Claude Code CLI",
			apple: "Apple Intelligence" };
		relocalizers.push(() => { describe(); hint(); });

		function describe() {
			if (!state) return;
			let a = api();
			if (!a) { state.textContent = ""; return; }
			let p = KNOWN.includes(sel.value) ? sel.value : a.provider();
			let err = a.providerReadyError(p);
			state.textContent = err ? T("p.chat.notready", { err })
				: sel.value ? T("p.chat.ready") : T("p.chat.current", { name: NAMES[p] || p });
		}

		// Champs « modèle » vides : on montre celui qui s'appliquera.
		let hints = {
			"annota-chat-model": ["annota.model", "mistral-large-latest"],
			"annota-chat-ollama-model": ["annota.ollamaModel", "llama3.1"]
		};
		function hint() {
			for (let id of Object.keys(hints)) {
				let el = document.getElementById(id);
				if (!el) continue;
				let [pref, fallback] = hints[id];
				let m = String(Zotero.Prefs.get(pref) || "").trim() || fallback;
				el.setAttribute("placeholder", T("p.sameai", { m }));
			}
		}
		hint();

		let stored = String(Zotero.Prefs.get(PREF) || "").trim();
		sel.value = KNOWN.includes(stored) ? stored : "";
		describe();
		sel.addEventListener("change", () => {
			Zotero.Prefs.set(PREF, sel.value);
			describe();
		});

		area.value = String(Zotero.Prefs.get(PREF_INSTR) || "");
		let timer = null;
		function save() {
			if (timer) { clearTimeout(timer); timer = null; }
			Zotero.Prefs.set(PREF_INSTR, area.value);
			if (status) {
				status.textContent = T("p.saved");
				setTimeout(() => { status.textContent = ""; }, 2000);
			}
		}
		area.addEventListener("input", () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(save, 1500);
		});
		area.addEventListener("blur", save);
	}

	// ---- Liaison data-pref ----
	// Chaque champ porteur de data-pref affiche sa préférence et l'écrit à la
	// modification. Le type d'origine est conservé : un entier reste un
	// entier, la température (chaîne historique) reste une chaîne, une case
	// à cocher écrit un booléen. Une saisie numérique invalide n'est pas
	// enregistrée plutôt que d'écrire NaN.
	function bindPrefs(tries) {
		let els = Array.from(document.querySelectorAll("[data-pref]"));
		if (!els.length) {
			retry(bindPrefs, tries);
			return;
		}
		for (let el of els) {
			let key = el.getAttribute("data-pref");
			let cur = Zotero.Prefs.get(key);
			let isBox = el.type === "checkbox";
			if (isBox) el.checked = !!cur;
			else el.value = (cur === undefined || cur === null) ? "" : String(cur);

			let write = () => {
				let v;
				if (isBox) v = !!el.checked;
				else if (typeof cur === "number") {
					v = el.step && /\./.test(el.step) ? parseFloat(el.value) : parseInt(el.value, 10);
					if (isNaN(v)) return;
				}
				else v = String(el.value);
				Zotero.Prefs.set(key, v);
				cur = v;
			};
			el.addEventListener(isBox ? "change" : "input", write);
			if (!isBox) el.addEventListener("change", write);
		}
	}

	// Clé d'API masquée par défaut, révélable le temps de la vérifier.
	function setupKeyToggle(tries) {
		let input = document.getElementById("annota-apikey");
		let btn = document.getElementById("annota-apikey-show");
		if (!input || !btn) {
			retry(setupKeyToggle, tries);
			return;
		}
		btn.addEventListener("click", () => {
			let show = input.type === "password";
			input.type = show ? "text" : "password";
			btn.textContent = T(show ? "p.hide" : "p.show");
		});
	}

	// ---- Claude Code CLI : détection, modèles, effort ----

	const CLI_KNOWN = { opus: "p.cli.desc.opus", sonnet: "p.cli.desc.sonnet",
		haiku: "p.cli.desc.haiku", fable: "" };
	const EFFORT_FALLBACK = ["low", "medium", "high", "xhigh", "max"];
	let cliPickers = [];

	function cliCaps() {
		let a = api();
		return (a && typeof a.cliCaps === "function" && a.cliCaps()) || null;
	}

	// Un menu de modèles + des boutons d'effort, liés à deux préférences.
	// inherit : libellé de l'option vide (« Default » ou « Same as AI tab »).
	function cliPicker({ select, other, effortHost, effortNote, modelPref, effortPref, inherit }) {
		const OTHER = "__other__";
		function build() {
			let caps = cliCaps();
			let stored = String(Zotero.Prefs.get(modelPref) || "").trim();
			let names = ((caps && caps.models) || []).slice();
			for (let k of Object.keys(CLI_KNOWN)) {
				if (k !== "fable" && !names.includes(k)) names.push(k);
			}
			select.textContent = "";
			let add = (v, l) => {
				let o = document.createElementNS(XHTML_NS, "option");
				o.setAttribute("value", v);
				o.textContent = l;
				select.appendChild(o);
			};
			add("", T(inherit));
			for (let n of names) add(n, n + (CLI_KNOWN[n] ? " (" + T(CLI_KNOWN[n]) + ")" : ""));
			add(OTHER, T("p.cli.other"));
			let isOther = stored && !names.includes(stored);
			select.value = isOther ? OTHER : stored;
			other.hidden = !isOther;
			if (isOther) other.value = stored;

			// Effort : seulement si le CLI le propose (ou n'a pas encore été
			// interrogé, auquel cas on montre les niveaux connus).
			effortHost.textContent = "";
			let supported = !caps || caps.effort;
			let levels = (caps && caps.efforts && caps.efforts.length) ? caps.efforts : EFFORT_FALLBACK;
			let cur = String(Zotero.Prefs.get(effortPref) || "").trim();
			if (effortNote) {
				effortNote.textContent = T(supported ? "p.cli.effortdefault" : "p.cli.noeffort");
			}
			effortHost.hidden = !supported;
			if (!supported) return;
			for (let v of [""].concat(levels)) {
				let b = document.createElementNS(XHTML_NS, "button");
				b.setAttribute("type", "button");
				b.setAttribute("class", "annota-seg-btn");
				b.textContent = v ? T("p.eff." + v) : T(inherit === "p.cli.same" ? "p.cli.btn.same" : "p.cli.btn.default");
				b.setAttribute("title", v ? "--effort " + v : T(inherit));
				b.setAttribute("aria-pressed", v === cur ? "true" : "false");
				b.addEventListener("click", () => {
					Zotero.Prefs.set(effortPref, v);
					for (let x of effortHost.children) {
						x.setAttribute("aria-pressed", x === b ? "true" : "false");
					}
				});
				effortHost.appendChild(b);
			}
		}
		select.addEventListener("change", () => {
			let v = select.value;
			other.hidden = v !== OTHER;
			if (v === OTHER) { other.focus(); return; }
			Zotero.Prefs.set(modelPref, v);
		});
		other.addEventListener("input", () => {
			Zotero.Prefs.set(modelPref, String(other.value || "").trim());
		});
		build();
		cliPickers.push(build);
	}

	function setupCLI(tries) {
		let detect = document.getElementById("annota-cli-detect");
		let status = document.getElementById("annota-cli-status");
		let pathInput = document.getElementById("annota-cli-path");
		let sel = document.getElementById("annota-cli-model");
		let chatSel = document.getElementById("annota-chat-cli-model");
		if (!detect || !sel || !chatSel || !pathInput) {
			retry(setupCLI, tries);
			return;
		}
		cliPicker({
			select: sel, other: document.getElementById("annota-cli-model-other"),
			effortHost: document.getElementById("annota-cli-effort"),
			effortNote: document.getElementById("annota-cli-effort-note"),
			modelPref: "annota.cliModel", effortPref: "annota.cliEffort",
			inherit: "p.cli.default"
		});
		cliPicker({
			select: chatSel, other: document.getElementById("annota-chat-cli-model-other"),
			effortHost: document.getElementById("annota-chat-cli-effort"),
			modelPref: "annota.chatCliModel", effortPref: "annota.chatCliEffort",
			inherit: "p.cli.same"
		});

		function describe(caps) {
			if (!status) return;
			status.textContent = caps ? T("p.cli.found", { v: caps.version, path: caps.path })
				: T("p.cli.notdetected");
		}
		describe(cliCaps());
		relocalizers.push(() => { describe(cliCaps()); for (let b of cliPickers) b(); });

		let busy = false;
		async function run(auto) {
			let a = api();
			if (busy || !a || typeof a.probeCLI !== "function") return;
			busy = true;
			if (!auto) status.textContent = T("p.cli.looking");
			try {
				let caps = await a.probeCLI(pathInput.value);
				// Chemin trouvé ailleurs que celui saisi : on l'adopte.
				if (caps.path && caps.path !== pathInput.value.trim()) {
					pathInput.value = caps.path;
					Zotero.Prefs.set("annota.cliPath", caps.path);
				}
				describe(caps);
				for (let b of cliPickers) b();
			}
			catch (e) {
				if (!auto) status.textContent = "⚠ " + (e.message || e);
			}
			finally { busy = false; }
		}
		detect.addEventListener("click", () => run(false));
		// Première ouverture : on interroge le CLI sans attendre de clic, sans
		// message d'erreur si rien n'est installé.
		if (!cliCaps()) run(true);
	}

	// Langue : appliquée au chargement, puis à chaque changement du menu.
	function setupLanguage(tries) {
		let sel = document.getElementById("annota-ui-lang");
		if (!sel) {
			retry(setupLanguage, tries);
			return;
		}
		applyI18n();
		// L'observateur de bootstrap.js reconstruit menus et discussion ; ici,
		// on traduit le panneau ouvert. Le délai laisse bindPrefs écrire la
		// préférence d'abord.
		sel.addEventListener("change", () => setTimeout(relocalize, 0));
	}

	bindPrefs();
	setupLanguage();
	setupKeyToggle();
	setupCLI();
	setupTabs();
	setup();
	setupProvider();
	setupOllama();
	setupChat();
})();
