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
		let swatchBox = document.getElementById("annota-swatches");
		let targetName = document.getElementById("annota-target-name");
		if (!textarea || !resetBtn || !swatchBox) {
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
			if (targetName) {
				let c = colors().find(x => x.hex === target);
				targetName.setAttribute("value",
					target ? (c ? c.name : target) : "Default (all colors)");
			}
			refreshSwatches();
		}

		// Reflète l'état : cible sélectionnée + couleurs ayant leur propre prompt.
		function refreshSwatches() {
			let map = readColorMap();
			for (let el of swatchBox.children) {
				let hex = el.getAttribute("data-color") || "";
				el.setAttribute("data-selected", hex === current ? "true" : "false");
				el.setAttribute("data-has-prompt", (hex && map[hex]) ? "true" : "false");
				if (hex) {
					let name = el.getAttribute("data-name") || hex;
					el.setAttribute("title",
						map[hex] ? name + " — custom prompt" : name + " — uses default prompt");
				}
			}
		}

		// --- Pastilles de couleur (défaut + palette Zotero) ---
		function addSwatch({ hex, name, label }) {
			let b = document.createElementNS(XHTML_NS, "button");
			b.setAttribute("type", "button");
			b.setAttribute("class", "annota-swatch" + (hex ? "" : " annota-default"));
			b.setAttribute("data-color", hex || "");
			if (hex) {
				b.setAttribute("data-name", name);
				b.style.backgroundColor = hex;
			}
			else {
				b.textContent = label;
				b.setAttribute("title", "Prompt used by every color without its own");
			}
			b.addEventListener("click", () => {
				if (current === (hex || "")) return;
				saveNow();          // ne pas perdre l'édition en cours
				load(hex || "");
			});
			swatchBox.appendChild(b);
			return b;
		}

		addSwatch({ hex: "", label: "Default" });
		for (let c of colors()) {
			addSwatch({ hex: c.hex, name: c.name });
		}

		// --- Textarea ---
		textarea.addEventListener("input", scheduleSave);
		textarea.addEventListener("blur", saveNow);

		// --- Boutons ---
		function restoreDefault() {
			Zotero.Prefs.clear(PREF_PROMPT);
			load("");
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
				refreshSwatches();
				flashStatus("Cleared ✓");
			}
			clearBtn.addEventListener("command", clearColor);
			clearBtn.addEventListener("click", clearColor);
		}

		load("");
		refreshSwatches();
	}

	setup();
})();
