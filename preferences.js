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
					? names.length + " installed"
					: "none installed — run: ollama pull llama3.1:8b");
			}
			catch (e) {
				fill([]);
				setStatus("Ollama unreachable — is it running?");
			}
		}

		sel.addEventListener("change", () => {
			Zotero.Prefs.set(PREF_MODEL, sel.value);
			setStatus("Saved ✓");
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
				where.textContent = "line " + p.line + " — ";
				row.appendChild(where);
			}
			let icon = document.createElementNS(XHTML_NS, "span");
			icon.textContent = (p.level === "error" ? "⚠️ " : "· ");
			row.appendChild(icon);
			row.appendChild(document.createTextNode(p.message));
			box.appendChild(row);
		}
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
			flashStatus("Saved ✓");
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
					? name + (entry.label ? " · " + entry.label : "") + " — "
						+ (entry.trigger === "manual" ? "on request" : "automatic")
					: name + " — inactive, no prompt";
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
		textarea.setAttribute("placeholder",
			"Empty — Annota ignores highlights of this color.");
		textarea.addEventListener("input", scheduleSave);
		textarea.addEventListener("blur", saveNow);
		templateArea.setAttribute("placeholder",
			"Empty — the comment is the AI's reply as-is.");
		templateArea.addEventListener("input", scheduleSave);
		templateArea.addEventListener("blur", saveNow);
		fieldsArea.setAttribute("placeholder", "name | Label | type | options");
		fieldsArea.addEventListener("input", scheduleSave);
		fieldsArea.addEventListener("blur", saveNow);
		labelInput.setAttribute("placeholder", "e.g. Objection");
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
				refreshSwatches();
				flashStatus("Cleared ✓");
			};
			clearBtn.addEventListener("click", clearColor);
		}

		load(current);
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

		function describe() {
			if (!state) return;
			let a = api();
			if (!a) { state.textContent = ""; return; }
			let p = KNOWN.includes(sel.value) ? sel.value : a.provider();
			let err = a.providerReadyError(p);
			state.textContent = err
				? "⚠️ Not set up yet: " + err
				: "✓ Ready" + (sel.value ? "" : " — currently " + (NAMES[p] || p));
		}

		// Champs « modèle » vides : on montre celui qui s'appliquera.
		let hints = {
			"annota-chat-model": ["annota.model", "mistral-large-latest"],
			"annota-chat-ollama-model": ["annota.ollamaModel", "llama3.1"],
			"annota-chat-cli-model": ["annota.cliModel", "CLI default"]
		};
		for (let id of Object.keys(hints)) {
			let el = document.getElementById(id);
			if (!el) continue;
			let [pref, fallback] = hints[id];
			let m = String(Zotero.Prefs.get(pref) || "").trim() || fallback;
			el.setAttribute("placeholder", "Same as AI tab: " + m);
		}

		let stored = String(Zotero.Prefs.get(PREF) || "").trim();
		sel.value = KNOWN.includes(stored) ? stored : "";
		describe();
		sel.addEventListener("change", () => {
			Zotero.Prefs.set(PREF, sel.value);
			describe();
		});

		area.value = String(Zotero.Prefs.get(PREF_INSTR) || "");
		area.setAttribute("placeholder",
			"e.g. I work in risk sociology; point out the theoretical framework.");
		let timer = null;
		function save() {
			if (timer) { clearTimeout(timer); timer = null; }
			Zotero.Prefs.set(PREF_INSTR, area.value);
			if (status) {
				status.textContent = "Saved ✓";
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
			btn.textContent = show ? "Hide" : "Show";
		});
	}

	bindPrefs();
	setupKeyToggle();
	setupTabs();
	setup();
	setupProvider();
	setupOllama();
	setupChat();
})();
