/* eslint-disable no-undef */
// Script du panneau de préférences.
//
// Le textarea est partagé : il édite soit le prompt par défaut
// (pref annota.systemPrompt), soit le prompt d'une couleur précise
// (entrée du JSON annota.colorPrompts). Le sélecteur « Editing prompt for »
// bascule entre les deux ; on sauvegarde toujours AVANT de basculer.

(function () {
	const PREF_PROMPT = "annota.systemPrompt";
	const PREF_COLORS = "annota.colorPrompts";
	const XHTML_NS = "http://www.w3.org/1999/xhtml";

	function api() {
		try { return Zotero.Annota || null; }
		catch (e) { return null; }
	}

	function presets() {
		let a = api();
		return (a && Array.isArray(a.PRESETS)) ? a.PRESETS : [];
	}

	function colors() {
		let a = api();
		return (a && Array.isArray(a.COLORS)) ? a.COLORS : [];
	}

	function defaultPrompt() {
		let a = api();
		return (a && a.DEFAULT_PROMPT) ? a.DEFAULT_PROMPT : "";
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
		// Ne pas conserver les entrées vides : une couleur sans prompt doit
		// retomber sur le prompt par défaut.
		let clean = {};
		for (let k of Object.keys(map)) {
			if (map[k] && String(map[k]).trim()) clean[k] = map[k];
		}
		Zotero.Prefs.set(PREF_COLORS, Object.keys(clean).length ? JSON.stringify(clean) : "");
	}

	function setup() {
		let textarea = document.getElementById("annota-prompt");
		let resetBtn = document.getElementById("annota-prompt-reset");
		let clearBtn = document.getElementById("annota-prompt-clear");
		let status = document.getElementById("annota-prompt-status");
		let presetSel = document.getElementById("annota-preset");
		let targetSel = document.getElementById("annota-target");
		if (!textarea || !resetBtn || !targetSel) {
			requestAnimationFrame(setup);
			return;
		}

		// Couleur en cours d'édition ("" = prompt par défaut).
		let current = "";

		let flashTimer = null;
		function flashStatus(msg) {
			if (!status) return;
			status.setAttribute("value", msg);
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => status.setAttribute("value", ""), 2000);
		}

		function save() {
			if (current) {
				let map = readColorMap();
				map[current] = textarea.value;
				writeColorMap(map);
			}
			else {
				Zotero.Prefs.set(PREF_PROMPT, textarea.value);
			}
			flashStatus("Saved ✓");
			refreshTargetLabels();
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

		// Charge dans le textarea le prompt de la cible demandée.
		function load(target) {
			current = target;
			if (target) {
				textarea.value = readColorMap()[target] || "";
				textarea.setAttribute("placeholder",
					"Empty — this color uses the default prompt.");
			}
			else {
				let saved = Zotero.Prefs.get(PREF_PROMPT);
				textarea.value = (saved && String(saved).trim()) ? saved : defaultPrompt();
				textarea.removeAttribute("placeholder");
			}
			if (clearBtn) clearBtn.hidden = !target;
			resetBtn.hidden = !!target;
		}

		// Marque d'un point les couleurs qui ont leur propre prompt.
		function refreshTargetLabels() {
			let map = readColorMap();
			for (let opt of targetSel.options) {
				if (!opt.value) continue;
				let base = opt.getAttribute("data-label") || opt.textContent;
				opt.setAttribute("data-label", base);
				opt.textContent = map[opt.value] ? base + " ●" : base;
			}
		}

		// --- Sélecteur de cible (défaut / couleurs) ---
		for (let c of colors()) {
			let opt = document.createElementNS(XHTML_NS, "option");
			opt.setAttribute("value", c.hex);
			opt.setAttribute("data-label", c.name);
			opt.textContent = c.name;
			targetSel.appendChild(opt);
		}
		targetSel.addEventListener("change", () => {
			saveNow();              // ne pas perdre l'édition en cours
			load(targetSel.value);
		});

		// --- Textarea ---
		textarea.addEventListener("input", scheduleSave);
		textarea.addEventListener("blur", saveNow);

		// --- Boutons ---
		function restoreDefault() {
			Zotero.Prefs.clear(PREF_PROMPT);
			load("");
			targetSel.value = "";
			flashStatus("Restored ✓");
		}
		resetBtn.addEventListener("command", restoreDefault);
		resetBtn.addEventListener("click", restoreDefault);

		if (clearBtn) {
			function clearColor() {
				if (!current) return;
				let map = readColorMap();
				delete map[current];
				writeColorMap(map);
				textarea.value = "";
				refreshTargetLabels();
				flashStatus("Cleared ✓");
			}
			clearBtn.addEventListener("command", clearColor);
			clearBtn.addEventListener("click", clearColor);
		}

		// --- Presets ---
		if (presetSel) {
			let list = presets();
			for (let p of list) {
				let opt = document.createElementNS(XHTML_NS, "option");
				opt.setAttribute("value", p.id);
				opt.textContent = p.label;
				presetSel.appendChild(opt);
			}
			presetSel.addEventListener("change", () => {
				let chosen = list.find(p => p.id === presetSel.value);
				if (chosen) {
					textarea.value = chosen.prompt;
					saveNow();
				}
				presetSel.value = ""; // back to the "pick a preset" label
			});
		}

		load("");
		refreshTargetLabels();
	}

	setup();
})();
