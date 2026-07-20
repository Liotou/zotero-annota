/* eslint-disable no-undef */
// Script du panneau de préférences : gère le textarea du prompt
// (pas de binding "preference" natif pour <textarea>), le sélecteur de
// modèles prédéfinis, et le bouton « restaurer le défaut ».

(function () {
	const PREF_PROMPT = "annota.systemPrompt";
	const XHTML_NS = "http://www.w3.org/1999/xhtml";

	function presets() {
		try {
			if (Zotero.Annota && Array.isArray(Zotero.Annota.PRESETS)) {
				return Zotero.Annota.PRESETS;
			}
		}
		catch (e) { /* ignore */ }
		return [];
	}

	function defaultPrompt() {
		try {
			if (Zotero.Annota && Zotero.Annota.DEFAULT_PROMPT) {
				return Zotero.Annota.DEFAULT_PROMPT;
			}
		}
		catch (e) { /* ignore */ }
		return "";
	}

	function setup() {
		let textarea = document.getElementById("annota-prompt");
		let resetBtn = document.getElementById("annota-prompt-reset");
		let status = document.getElementById("annota-prompt-status");
		let presetSel = document.getElementById("annota-preset");
		if (!textarea || !resetBtn) {
			// Le DOM du panneau n'est pas encore prêt : réessayer au prochain tick.
			requestAnimationFrame(setup);
			return;
		}

		let saved = Zotero.Prefs.get(PREF_PROMPT);
		textarea.value = (saved && String(saved).trim()) ? saved : defaultPrompt();

		let flashTimer = null;
		function flashStatus(msg) {
			if (!status) return;
			status.setAttribute("value", msg);
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => status.setAttribute("value", ""), 2000);
		}

		let saveTimer = null;
		function save() {
			Zotero.Prefs.set(PREF_PROMPT, textarea.value);
			flashStatus("Enregistré ✓");
		}
		function scheduleSave() {
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(save, 500);
		}

		textarea.addEventListener("input", scheduleSave);
		textarea.addEventListener("blur", () => {
			if (saveTimer) clearTimeout(saveTimer);
			save();
		});

		function restoreDefault() {
			Zotero.Prefs.clear(PREF_PROMPT);
			textarea.value = defaultPrompt();
			flashStatus("Restauré ✓");
		}
		// <button> XUL émet "command"; en HTML pur ce serait "click".
		resetBtn.addEventListener("command", restoreDefault);
		resetBtn.addEventListener("click", restoreDefault);

		// Sélecteur de modèles prédéfinis : remplit le textarea avec le modèle choisi.
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
					save();
				}
				presetSel.value = ""; // revenir au libellé « choisir un modèle »
			});
		}
	}

	setup();
})();
