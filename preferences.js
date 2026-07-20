/* eslint-disable no-undef */
// Script du panneau de préférences : gère le textarea du prompt système
// (pas de binding "preference" natif pour <textarea>) et le bouton reset.

(function () {
	const PREF_PROMPT = "annota.systemPrompt";

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

		resetBtn.addEventListener("command", () => {
			Zotero.Prefs.clear(PREF_PROMPT);
			textarea.value = defaultPrompt();
			flashStatus("Réinitialisé ✓");
		});
		// <button> XUL utilise "command"; en HTML pur ce serait "click".
		resetBtn.addEventListener("click", () => {
			Zotero.Prefs.clear(PREF_PROMPT);
			textarea.value = defaultPrompt();
			flashStatus("Réinitialisé ✓");
		});
	}

	setup();
})();
