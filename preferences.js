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
	const PREF_COLORS = "annota.colorPrompts";
	const XHTML_NS = "http://www.w3.org/1999/xhtml";

	function api() {
		try { return Zotero.Annota || null; }
		catch (e) { return null; }
	}

	function colors() {
		let a = api();
		return (a && Array.isArray(a.COLORS)) ? a.COLORS : [];
	}

	// Normalise une valeur brute (chaîne ancienne ou objet) en { prompt, trigger }.
	function normalize(raw) {
		if (!raw) return null;
		if (typeof raw === "string") {
			return raw.trim() ? { prompt: raw, trigger: "auto" } : null;
		}
		if (typeof raw === "object" && raw.prompt && String(raw.prompt).trim()) {
			return {
				prompt: String(raw.prompt),
				trigger: raw.trigger === "manual" ? "manual" : "auto"
			};
		}
		return null;
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

	function setup() {
		let textarea = document.getElementById("annota-prompt");
		let clearBtn = document.getElementById("annota-prompt-clear");
		let status = document.getElementById("annota-prompt-status");
		let swatchBox = document.getElementById("annota-swatches");
		let targetName = document.getElementById("annota-target-name");
		let idleWarning = document.getElementById("annota-idle-warning");
		let triggerGroup = document.getElementById("annota-trigger");
		if (!textarea || !swatchBox || !triggerGroup) {
			requestAnimationFrame(setup);
			return;
		}

		let palette = colors();
		if (!palette.length) {
			requestAnimationFrame(setup);
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
			if (prompt && prompt.trim()) {
				map[current] = { prompt, trigger: currentTrigger() };
			}
			else {
				delete map[current];
			}
			writeColorMap(map);
			flashStatus("Saved ✓");
			refreshSwatches();
		}

		let saveTimer = null;
		function scheduleSave() {
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(save, 500);
		}
		function saveNow() {
			if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
			save();
		}

		function load(hex) {
			current = hex;
			let entry = normalize(readColorMap()[hex]);
			textarea.value = entry ? entry.prompt : "";
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

		// --- Choix du mode (auto / manuel) ---
		// Ne sauvegarde que si la couleur a déjà un prompt (sinon rien à régler).
		triggerGroup.addEventListener("command", () => {
			if (textarea.value && textarea.value.trim()) saveNow();
		});

		// --- Bouton d'effacement ---
		if (clearBtn) {
			let clearColor = () => {
				let map = readColorMap();
				delete map[current];
				writeColorMap(map);
				textarea.value = "";
				triggerGroup.value = "auto";
				refreshSwatches();
				flashStatus("Cleared ✓");
			};
			clearBtn.addEventListener("command", clearColor);
			clearBtn.addEventListener("click", clearColor);
		}

		load(current);
	}

	setup();
})();
