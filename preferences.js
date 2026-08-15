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
			return raw.trim() ? { prompt: raw, trigger: "auto", template: "", fields: "" } : null;
		}
		if (typeof raw !== "object") return null;
		let prompt = String(raw.prompt || "");
		let template = String(raw.template || "");
		let fields = String(raw.fields || "");
		if (!prompt.trim() && !template.trim() && !fields.trim()) return null;
		return {
			prompt,
			template,
			fields,
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
			general: document.getElementById("annota-pane-general")
		};
		if (!bar || !panes.colors || !panes.ai || !panes.general) {
			retry(setupTabs, tries);
			return;
		}

		let tabs = Array.from(bar.querySelectorAll(".annota-tab"));
		if (!tabs.length) return;

		function apply(name) {
			for (let key of Object.keys(panes)) panes[key].hidden = (key !== name);
			for (let t of tabs) {
				let on = t.getAttribute("data-pane") === name;
				t.setAttribute("data-active", on ? "true" : "false");
				t.setAttribute("aria-selected", on ? "true" : "false");
			}
		}

		for (let t of tabs) {
			t.addEventListener("click", () => apply(t.getAttribute("data-pane")));
		}
		apply("colors");
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
			if (status) status.setAttribute("value", msg || "");
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
		btn.addEventListener("command", refresh);
		btn.addEventListener("click", refresh);

		fill([]);        // afficher au moins la valeur enregistrée
		refresh();       // puis interroger Ollama
	}

	function setup(tries) {
		let textarea = document.getElementById("annota-prompt");
		let clearBtn = document.getElementById("annota-prompt-clear");
		let status = document.getElementById("annota-prompt-status");
		let swatchBox = document.getElementById("annota-swatches");
		let targetName = document.getElementById("annota-target-name");
		let idleWarning = document.getElementById("annota-idle-warning");
		let triggerGroup = document.getElementById("annota-trigger");
		let templateArea = document.getElementById("annota-template");
		let fieldsArea = document.getElementById("annota-fields");
		if (!textarea || !swatchBox || !triggerGroup || !templateArea || !fieldsArea) {
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
			status.setAttribute("value", msg);
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => status.setAttribute("value", ""), 2000);
		}

		function currentTrigger() {
			let v = triggerGroup.value || triggerGroup.getAttribute("value");
			return v === "manual" ? "manual" : "auto";
		}

		function save() {
			let map = readColorMap();
			let prompt = textarea.value;
			let template = templateArea.value;
			let fields = fieldsArea.value;
			// Actif si prompt OU gabarit OU champs.
			if ((prompt && prompt.trim()) || (template && template.trim())
					|| (fields && fields.trim())) {
				map[current] = { prompt, template, fields, trigger: currentTrigger() };
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
		let saveTimer = null;
		function scheduleSave() {
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
			triggerGroup.value = entry ? entry.trigger : "auto";
			if (targetName) {
				let c = palette.find(x => x.hex === hex);
				targetName.setAttribute("value", c ? c.name : hex);
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
					? name + " — " + (entry.trigger === "manual" ? "on request" : "automatic")
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

		// --- Choix du mode (auto / manuel) ---
		// Ne sauvegarde que si la couleur a déjà un prompt (sinon rien à régler).
		triggerGroup.addEventListener("command", () => {
			if ((textarea.value && textarea.value.trim())
					|| (templateArea.value && templateArea.value.trim())
					|| (fieldsArea.value && fieldsArea.value.trim())) saveNow();
		});

		// --- Bouton d'effacement ---
		if (clearBtn) {
			let clearColor = () => {
				let map = readColorMap();
				delete map[current];
				writeColorMap(map);
				textarea.value = "";
				templateArea.value = "";
				fieldsArea.value = "";
				triggerGroup.value = "auto";
				refreshSwatches();
				flashStatus("Cleared ✓");
			};
			clearBtn.addEventListener("command", clearColor);
			clearBtn.addEventListener("click", clearColor);
		}

		load(current);
	}

	setupTabs();
	setup();
	setupProvider();
	setupOllama();
})();
