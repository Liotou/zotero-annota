/* eslint-disable no-undef */
// Script du panneau de préférences.
//
// Il n'y a pas de prompt par défaut : chaque couleur de surlignage a le sien,
// stocké dans le JSON annota.colorPrompts. Une couleur sans prompt n'est pas
// traitée par le plugin. Le textarea édite la couleur sélectionnée ; on
// sauvegarde toujours AVANT de changer de couleur.

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
		// Ne pas conserver les entrées vides : une couleur sans prompt est une
		// couleur désactivée, pas une couleur avec un prompt vide.
		let clean = {};
		for (let k of Object.keys(map)) {
			if (map[k] && String(map[k]).trim()) clean[k] = map[k];
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
		if (!textarea || !swatchBox) {
			requestAnimationFrame(setup);
			return;
		}

		let palette = colors();
		if (!palette.length) {
			requestAnimationFrame(setup);
			return;
		}

		// Couleur en cours d'édition (toujours une couleur : il n'y a plus de défaut).
		let current = palette[0].hex;

		let flashTimer = null;
		function flashStatus(msg) {
			if (!status) return;
			status.setAttribute("value", msg);
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => status.setAttribute("value", ""), 2000);
		}

		function save() {
			let map = readColorMap();
			map[current] = textarea.value;
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
			textarea.value = readColorMap()[hex] || "";
			if (targetName) {
				let c = palette.find(x => x.hex === hex);
				targetName.setAttribute("value", c ? c.name : hex);
			}
			refreshSwatches();
		}

		// Reflète l'état : couleur sélectionnée, couleurs actives, avertissement
		// si le plugin ne peut rien générer faute de prompt configuré.
		function refreshSwatches() {
			let map = readColorMap();
			for (let el of swatchBox.children) {
				let hex = el.getAttribute("data-color");
				let name = el.getAttribute("data-name") || hex;
				el.setAttribute("data-selected", hex === current ? "true" : "false");
				el.setAttribute("data-has-prompt", map[hex] ? "true" : "false");
				el.setAttribute("title",
					map[hex] ? name + " — has a prompt" : name + " — inactive, no prompt");
			}
			if (idleWarning) {
				idleWarning.hidden = Object.keys(map).length > 0;
			}
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

		// --- Bouton d'effacement ---
		if (clearBtn) {
			let clearColor = () => {
				let map = readColorMap();
				delete map[current];
				writeColorMap(map);
				textarea.value = "";
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
