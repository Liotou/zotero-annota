/* eslint-disable no-undef */
// Annota — extension Zotero 7/8/9
// À la création d'un surlignage, exécute un prompt configurable sur le texte
// surligné et place la sortie du modèle dans le commentaire de l'annotation.

var Annota;

const PREF_BRANCH = "annota.";

// Commentaire temporaire affiché pendant l'appel réseau (écrit puis remplacé).
const PLACEHOLDER = "⏳ Generating…";

function getPref(key, fallback) {
	let val = Zotero.Prefs.get(PREF_BRANCH + key);
	return (val === undefined || val === null) ? fallback : val;
}

function log(msg) {
	Zotero.debug("[Annota] " + msg);
}

function toast(title, body, type = "default") {
	try {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(title);
		if (body) {
			let icon = type === "error"
				? "chrome://zotero/skin/cross.png"
				: "chrome://zotero/skin/tick.png";
			pw.addLines([body], [icon]);
		}
		pw.show();
		pw.startCloseTimer(type === "error" ? 6000 : 2500);
	}
	catch (e) {
		log("toast failed: " + e);
	}
}

Annota = {
	id: null,
	version: null,
	rootURI: null,
	notifierID: null,
	inProgress: new Set(),

	// Il n'existe volontairement AUCUN prompt par défaut : chaque couleur de
	// surlignage a le sien, et une couleur sans prompt n'est pas traitée du tout.
	// C'est ce qui permet de n'activer la génération que sur certaines couleurs.
	//
	// Variables substituées à l'exécution :
	//   {{text}}        texte surligné (voir buildMessages pour le mode avancé)
	//   {{title}}       titre du document source
	//   {{authors}}     auteurs du document source (noms, séparés par des virgules)
	//   {{year}}        année du document source
	//   {{abstract}}    résumé du document source (tronqué selon les préférences)
	//   {{publication}} revue / ouvrage / actes
	//   {{page}}        page du passage surligné
	//   {{maxWords}}    réglage « longueur max »
	//   {{language}}    réglage « langue de sortie »
	// Des exemples de prompts sont fournis dans PROMPT-EXAMPLES.txt.

	// Palette de secours, si Zotero.Annotations.COLORS était indisponible.
	// Doit rester alignée sur chrome/content/zotero/xpcom/annotations.js.
	FALLBACK_COLORS: [
		{ hex: "#ffd400", name: "Yellow" },
		{ hex: "#ff6666", name: "Red" },
		{ hex: "#5fb236", name: "Green" },
		{ hex: "#2ea8e5", name: "Blue" },
		{ hex: "#a28ae5", name: "Purple" },
		{ hex: "#e56eee", name: "Magenta" },
		{ hex: "#f19837", name: "Orange" },
		{ hex: "#aaaaaa", name: "Gray" }
	],

	// Palette de surlignage lue directement depuis Zotero : elle reste ainsi
	// identique à celle du sélecteur de couleurs du lecteur, même si Zotero
	// la fait évoluer. Format source : [clé l10n, hex].
	get COLORS() {
		try {
			let raw = Zotero.Annotations && Zotero.Annotations.COLORS;
			if (Array.isArray(raw) && raw.length) {
				return raw.map(pair => ({
					hex: String(pair[1]).toLowerCase(),
					name: String(pair[0])
						.replace(/^general-/, "")
						.replace(/^./, m => m.toUpperCase())
				}));
			}
		}
		catch (e) {
			log("COLORS: lecture de la palette Zotero impossible, repli : " + e);
		}
		return this.FALLBACK_COLORS;
	},

	// Prompts par couleur : { "#ff6666": "…", … }. Vide = utiliser le prompt par défaut.
	getColorPrompts() {
		try {
			let raw = String(getPref("colorPrompts", "") || "").trim();
			if (!raw) return {};
			let obj = JSON.parse(raw);
			return (obj && typeof obj === "object") ? obj : {};
		}
		catch (e) {
			log("colorPrompts illisible (JSON invalide), ignoré : " + e);
			return {};
		}
	},

	// Réglage d'une couleur, normalisé : { prompt, trigger } ou null si vide.
	// Rétrocompat : une valeur chaîne = { prompt, trigger: "auto" }.
	// trigger "auto"   = génère à la création du surlignage (mode 1)
	// trigger "manual" = uniquement via le menu contextuel (mode 2)
	getColorEntry(color) {
		if (!color) return null;
		let raw = this.getColorPrompts()[String(color).toLowerCase()];
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
	},

	// Prompt configuré pour cette couleur, ou "" si la couleur n'en a pas.
	getPromptForColor(color) {
		let entry = this.getColorEntry(color);
		return entry ? entry.prompt : "";
	},

	// Fournisseur actif : CLI local si activé, sinon Mistral/compatible OpenAI.
	provider() {
		return getPref("useClaudeCLI", false) ? "cli" : "mistral";
	},
	// Vérifie que le fournisseur choisi est prêt ; renvoie un message ou null.
	providerReadyError() {
		if (this.provider() === "cli") {
			return String(getPref("cliPath", "claude")).trim()
				? null : "Claude CLI path not set (Preferences → Annota).";
		}
		return String(getPref("apiKey", "")).trim()
			? null : "API key missing (Preferences → Annota).";
	},

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	registerNotifier() {
		this.notifierID = Zotero.Notifier.registerObserver(
			this.notifierCallback,
			["item"],
			"annota"
		);
		log("Notifier registered (id=" + this.notifierID + ")");
	},

	unregisterNotifier() {
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
	},

	notifierCallback: {
		notify(event, type, ids, _extraData) {
			// On ne réagit qu'à la CRÉATION d'items. Il n'y a pas d'interrupteur
			// global : handleItem() ne génère que pour les couleurs réglées sur
			// « auto ». Tout mettre sur « à la demande » désactive l'automatique.
			if (event !== "add" || type !== "item") return;
			for (let id of ids) {
				// fire-and-forget : ne pas bloquer la transaction Zotero
				Annota.handleItem(id).catch(e => log("handleItem: " + e));
			}
		}
	},

	targetTypes() {
		let types = ["highlight"];
		if (getPref("alsoUnderline", false)) types.push("underline");
		return types;
	},

	async handleItem(id) {
		if (this.inProgress.has(id)) return;

		let item;
		try {
			item = await Zotero.Items.getAsync(id);
		}
		catch (e) {
			return;
		}
		if (!item || !item.isAnnotation || !item.isAnnotation()) return;

		if (!this.targetTypes().includes(item.annotationType)) return;

		// Bibliothèque en lecture seule ? on ignore.
		if (item.library && item.library.editable === false) return;

		let text = (item.annotationText || "").trim();
		if (!text) return;

		// Mode 1 (automatique) : ne se déclenche que si la couleur a un prompt
		// ET que ce prompt est réglé sur « auto ». Les couleurs « manuel » ne
		// réagissent qu'au menu contextuel. Couleur sans prompt = ignorée.
		let entry = this.getColorEntry(item.annotationColor);
		if (!entry || entry.trigger !== "auto") return;

		// Commentaire déjà saisi (paraphrase manuelle) : capturé avant tout,
		// pour la variable {{comment}} et pour respecter « ne pas écraser ».
		let existing = (item.annotationComment || "").trim();
		let overwrite = getPref("overwrite", false);
		if (existing && !overwrite) return;

		let notReady = this.providerReadyError();
		if (notReady) {
			toast("Annota", notReady, "error");
			return;
		}

		this.inProgress.add(id);
		let usedPlaceholder = false;
		try {
			if (getPref("showPlaceholder", true)) {
				item.annotationComment = PLACEHOLDER;
				await item.saveTx();
				usedPlaceholder = true;
			}

			let ctx = this.getContext(item);
			let comment = await this.generateComment({
				text, ctx, color: item.annotationColor, comment: existing
			});

			// Recharger l'item au cas où il aurait changé pendant l'appel réseau.
			let fresh = await Zotero.Items.getAsync(id);
			if (!fresh) return;
			fresh.annotationComment = comment;
			await fresh.saveTx();
			log("Comment generated for annotation " + id);
		}
		catch (e) {
			log("Generation error: " + e);
			toast("Annota", "Generation failed: " + (e.message || e), "error");
			// Nettoyer le placeholder en cas d'échec.
			if (usedPlaceholder) {
				try {
					let fresh = await Zotero.Items.getAsync(id);
					if (fresh && (fresh.annotationComment || "").trim() === PLACEHOLDER) {
						fresh.annotationComment = "";
						await fresh.saveTx();
					}
				}
				catch (e2) { /* ignore */ }
			}
		}
		finally {
			this.inProgress.delete(id);
		}
	},

	// Tronque une chaîne à `max` caractères (0/absent = pas de limite).
	truncate(s, max) {
		s = String(s || "").trim();
		if (!max || s.length <= max) return s;
		return s.slice(0, max).trim() + "…";
	},

	// Métadonnées du document source, pour les variables {{title}}, {{authors}},
	// {{year}}, {{abstract}}, {{publication}}, {{page}}.
	getContext(item) {
		let ctx = {
			title: "", authors: "", year: "",
			abstract: "", publication: "", page: ""
		};
		try {
			// Page de l'annotation (telle qu'affichée dans le PDF).
			ctx.page = item.annotationPageLabel || "";

			let parent = item.parentItem;               // pièce jointe (PDF)
			let top = (parent && parent.parentItem) ? parent.parentItem : parent;
			if (top && typeof top.getField === "function") {
				ctx.title = top.getField("title") || "";
				ctx.publication = top.getField("publicationTitle")
					|| top.getField("bookTitle")
					|| top.getField("proceedingsTitle")
					|| "";

				let maxAbs = parseInt(getPref("maxAbstractChars", 1200), 10);
				if (isNaN(maxAbs)) maxAbs = 1200;
				ctx.abstract = this.truncate(top.getField("abstractNote") || "", maxAbs);

				let ym = String(top.getField("date") || "").match(/\d{4}/);
				if (ym) ctx.year = ym[0];

				let creators = (typeof top.getCreators === "function") ? top.getCreators() : [];
				ctx.authors = creators
					.map(c => c.lastName || c.name || "")
					.filter(Boolean)
					.join(", ");
			}
		}
		catch (e) {
			log("getContext: " + e);
		}
		return ctx;
	},

	// Bloc de contexte lisible, transmis à l'IA en mode standard.
	formatContextBlock(vars) {
		let lines = [];
		if (vars.title) lines.push("Title: " + vars.title);
		if (vars.authors) lines.push("Authors: " + vars.authors);
		if (vars.year) lines.push("Year: " + vars.year);
		if (vars.publication) lines.push("Publication: " + vars.publication);
		if (vars.page) lines.push("Passage page: " + vars.page);
		if (vars.abstract) lines.push("Document abstract: " + vars.abstract);
		return lines.length ? "Document context:\n" + lines.join("\n") : "";
	},

	// Remplace {{variable}} par sa valeur (chaîne vide si inconnue).
	substitute(tpl, vars) {
		return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
			(Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null)
				? String(vars[key]) : "");
	},

	// Construit le prompt à envoyer : { system, user }.
	// - Mode avancé (le prompt contient {{text}} ou {{comment}}) : tout est mis
	//   dans le message utilisateur, l'utilisateur contrôle la structure.
	// - Mode standard : le prompt sert d'instructions (system), le passage (et
	//   le contexte du document si activé) est ajouté comme message utilisateur.
	buildPrompt({ text, ctx, color, comment }) {
		let tpl = this.getPromptForColor(color);
		let vars = {
			text: text,
			comment: comment || "",
			title: (ctx && ctx.title) || "",
			authors: (ctx && ctx.authors) || "",
			year: (ctx && ctx.year) || "",
			abstract: (ctx && ctx.abstract) || "",
			publication: (ctx && ctx.publication) || "",
			page: (ctx && ctx.page) || "",
			maxWords: parseInt(getPref("maxWords", 80), 10) || 80,
			language: String(getPref("language", "français")).trim() || "français"
		};

		let selfContained = /\{\{\s*(text|comment)\s*\}\}/.test(tpl);
		if (selfContained) {
			return { system: "", user: this.substitute(tpl, vars) };
		}

		let parts = [];
		if (getPref("sendContext", true)) {
			let block = this.formatContextBlock(vars);
			if (block) parts.push(block);
		}
		if (comment && String(comment).trim()) {
			parts.push("Existing note:\n\"\"\"\n" + comment + "\n\"\"\"");
		}
		parts.push("Highlighted passage:\n\"\"\"\n" + text + "\n\"\"\"");

		return { system: this.substitute(tpl, vars), user: parts.join("\n\n") };
	},

	async generateComment({ text, ctx, color, comment }) {
		let prompt = this.buildPrompt({ text, ctx, color, comment });
		return this.provider() === "cli"
			? this.callCLI(prompt)
			: this.callOpenAI(prompt);
	},

	// Claude Code CLI local (`claude -p`). Utilise l'abonnement connecté du CLI,
	// pas l'API facturée au token. Aucune clé API : l'authentification est celle
	// de `claude` sur la machine. Lent (démarrage à froid par appel).
	async callCLI({ system, user }) {
		let Subprocess;
		try {
			({ Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs"));
		}
		catch (e) {
			throw new Error("Subprocess indisponible : " + (e.message || e));
		}

		let cmd = String(getPref("cliPath", "claude")).trim() || "claude";
		let model = String(getPref("cliModel", "")).trim();
		let args = ["-p", "--output-format", "text"];
		if (model) args.push("--model", model);
		if (system) args.push("--append-system-prompt", system);

		// Répertoire de travail neutre : évite de charger un CLAUDE.md de projet.
		let workdir;
		try { workdir = Zotero.getTempDirectory().path; } catch (e) { workdir = undefined; }

		let proc;
		try {
			proc = await Subprocess.call({
				command: cmd,
				arguments: args,
				workdir,
				stderr: "pipe"
			});
		}
		catch (e) {
			throw new Error("Impossible de lancer le CLI « " + cmd + " » : " + (e.message || e));
		}

		// Garde-fou : tuer le process s'il dépasse le délai (ex. non connecté).
		let killTimer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 120000);
		try {
			await proc.stdin.write(user);
			await proc.stdin.close();

			let out = "", chunk;
			while ((chunk = await proc.stdout.readString()) !== "") out += chunk;
			let errText = "", ce;
			while ((ce = await proc.stderr.readString()) !== "") errText += ce;

			let { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new Error("CLI code " + exitCode + " : "
					+ (errText.trim() || "(pas de sortie d'erreur)").slice(0, 300));
			}
			if (!out.trim()) throw new Error("Réponse vide du CLI");
			return this.sanitize(out);
		}
		finally {
			clearTimeout(killTimer);
		}
	},

	// Fournisseur compatible OpenAI (Mistral par défaut).
	async callOpenAI({ system, user }) {
		let apiKey = String(getPref("apiKey", "")).trim();
		if (!apiKey) throw new Error("Mistral API key missing");
		let endpoint = String(getPref("endpoint", "https://api.mistral.ai/v1/chat/completions")).trim();
		let model = String(getPref("model", "mistral-large-latest")).trim() || "mistral-large-latest";
		let temp = parseFloat(getPref("temperature", 0.2));
		if (isNaN(temp)) temp = 0.2;
		temp = Math.max(0, Math.min(2, temp));

		let messages = system
			? [{ role: "system", content: system }, { role: "user", content: user }]
			: [{ role: "user", content: user }];

		let resp = await this.httpJSON(endpoint, {
			"Content-Type": "application/json",
			"Authorization": "Bearer " + apiKey
		}, { model, temperature: temp, messages });

		let data = resp.response;
		let content = data && data.choices && data.choices[0]
			&& data.choices[0].message && data.choices[0].message.content;
		if (!content) throw new Error("Empty API response");
		return this.sanitize(content);
	},

	// POST JSON commun, avec message d'erreur lisible.
	async httpJSON(url, headers, payload) {
		try {
			return await Zotero.HTTP.request("POST", url, {
				headers,
				body: JSON.stringify(payload),
				responseType: "json",
				timeout: 45000
			});
		}
		catch (e) {
			let status = e && e.xmlhttp ? e.xmlhttp.status : "?";
			let detail = "";
			try { detail = e.xmlhttp ? e.xmlhttp.responseText : ""; } catch (e2) {}
			throw new Error("API (HTTP " + status + ") " + detail.slice(0, 300));
		}
	},

	// ---- Traitement a posteriori (menu contextuel) ----

	// Rassemble les annotations éligibles à partir d'une sélection : items
	// classiques, pièces jointes, ou annotations sélectionnées directement.
	async collectAnnotations(items) {
		let out = [];
		let seen = new Set();

		let push = (ann) => {
			if (ann && !seen.has(ann.id)) { seen.add(ann.id); out.push(ann); }
		};

		for (let item of items) {
			try {
				if (item.isAnnotation && item.isAnnotation()) { push(item); continue; }

				let attachments = [];
				if (item.isAttachment && item.isAttachment()) {
					attachments = [item];
				}
				else if (item.isRegularItem && item.isRegularItem()) {
					let ids = item.getAttachments();
					attachments = await Zotero.Items.getAsync(ids);
				}

				for (let att of attachments) {
					if (!att || !att.isFileAttachment || !att.isFileAttachment()) continue;
					for (let ann of att.getAnnotations()) push(ann);
				}
			}
			catch (e) {
				log("collectAnnotations: " + e);
			}
		}
		return out;
	},

	// Annotation traitable ? (type ciblé, texte non vide, bibliothèque modifiable)
	isEligible(ann, overwrite) {
		if (!ann || !ann.isAnnotation || !ann.isAnnotation()) return false;
		if (!this.targetTypes().includes(ann.annotationType)) return false;
		if (ann.library && ann.library.editable === false) return false;
		if (!(ann.annotationText || "").trim()) return false;
		if ((ann.annotationComment || "").trim() && !overwrite) return false;
		return true;
	},

	// Lance la génération sur la sélection courante de la fenêtre.
	// Volontairement indépendant de la préférence « enabled » : l'action est explicite.
	async runBatch(window, opts = {}) {
		let overwrite = !!opts.overwrite;

		let notReady = this.providerReadyError();
		if (notReady) {
			toast("Annota", notReady, "error");
			return;
		}

		let selected;
		try {
			selected = window.ZoteroPane.getSelectedItems();
		}
		catch (e) {
			log("runBatch: sélection illisible : " + e);
			return;
		}
		if (!selected || !selected.length) return;

		let all = await this.collectAnnotations(selected);
		let eligible = all.filter(a => this.isEligible(a, overwrite));

		// Les couleurs sans prompt sont ignorées : on les compte à part pour
		// pouvoir l'expliquer, sinon l'absence de résultat serait incompréhensible.
		let targets = [];
		let noPrompt = 0;
		for (let a of eligible) {
			if (this.getPromptForColor(a.annotationColor)) targets.push(a);
			else noPrompt++;
		}

		if (!targets.length) {
			let why;
			if (noPrompt) {
				why = noPrompt + " highlight" + (noPrompt > 1 ? "s" : "")
					+ " skipped — their color has no prompt yet (Preferences → Annota).";
			}
			else if (all.length) {
				why = "Nothing to do — all annotations already have comments.";
			}
			else {
				why = "No highlight annotations found in the selection.";
			}
			toast("Annota", why);
			return;
		}

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Annota");
		let bar = new pw.ItemProgress(
			"chrome://zotero/skin/tick.png",
			"Generating 0/" + targets.length + "…"
		);
		pw.show();

		let ok = 0, failed = 0;
		for (let i = 0; i < targets.length; i++) {
			let ann = targets[i];
			try {
				let ctx = this.getContext(ann);
				// Le menu contextuel traite toutes les couleurs ayant un prompt,
				// « auto » ou « manuel ». Le commentaire existant (paraphrase
				// manuelle) est transmis via {{comment}}.
				let comment = await this.generateComment({
					text: (ann.annotationText || "").trim(),
					ctx,
					color: ann.annotationColor,
					comment: (ann.annotationComment || "").trim()
				});
				let fresh = await Zotero.Items.getAsync(ann.id);
				if (fresh) {
					fresh.annotationComment = comment;
					await fresh.saveTx();
					ok++;
				}
			}
			catch (e) {
				failed++;
				log("runBatch item " + ann.id + " : " + e);
			}
			bar.setProgress(Math.round(((i + 1) / targets.length) * 100));
			bar.setText("Generating " + (i + 1) + "/" + targets.length + "…");
		}

		bar.setProgress(100);
		let summary = ok + " comment" + (ok > 1 ? "s" : "") + " generated";
		if (failed) summary += ", " + failed + " failed (see debug output)";
		if (noPrompt) summary += ", " + noPrompt + " skipped (color has no prompt)";
		bar.setText(summary);
		pw.startCloseTimer(failed ? 8000 : 4000);
		log("runBatch terminé : " + ok + " ok, " + failed + " échecs, "
			+ noPrompt + " sans prompt");
	},

	// ---- Menu contextuel (une entrée par fenêtre principale) ----

	_windows: new Map(),

	selectionIsRelevant(window) {
		try {
			let items = window.ZoteroPane.getSelectedItems();
			if (!items || !items.length) return false;
			return items.some(i =>
				(i.isAnnotation && i.isAnnotation())
				|| (i.isAttachment && i.isAttachment())
				|| (i.isRegularItem && i.isRegularItem()));
		}
		catch (e) {
			return false;
		}
	},

	addToWindow(window) {
		try {
			if (this._windows.has(window)) return;
			let doc = window.document;
			let itemmenu = doc.getElementById("zotero-itemmenu");
			if (!itemmenu) return;

			let menu = doc.createXULElement("menu");
			menu.id = "annota-itemmenu";
			menu.setAttribute("label", "Annota");

			let popup = doc.createXULElement("menupopup");

			let missing = doc.createXULElement("menuitem");
			missing.setAttribute("label", "Generate missing comments");
			missing.addEventListener("command", () => {
				Annota.runBatch(window, { overwrite: false })
					.catch(e => log("runBatch: " + e));
			});
			popup.appendChild(missing);

			let all = doc.createXULElement("menuitem");
			all.setAttribute("label", "Regenerate all comments");
			all.addEventListener("command", () => {
				Annota.runBatch(window, { overwrite: true })
					.catch(e => log("runBatch: " + e));
			});
			popup.appendChild(all);

			menu.appendChild(popup);
			itemmenu.appendChild(menu);

			// Masquer l'entrée quand la sélection ne peut porter aucune annotation.
			let onShowing = () => { menu.hidden = !Annota.selectionIsRelevant(window); };
			itemmenu.addEventListener("popupshowing", onShowing);

			this._windows.set(window, { menu, itemmenu, onShowing });
			log("Menu ajouté à la fenêtre");
		}
		catch (e) {
			log("addToWindow: " + e);
		}
	},

	removeFromWindow(window) {
		let rec = this._windows.get(window);
		if (!rec) return;
		try { rec.itemmenu.removeEventListener("popupshowing", rec.onShowing); } catch (e) {}
		try { rec.menu.remove(); } catch (e) {}
		this._windows.delete(window);
	},

	removeFromAllWindows() {
		for (let window of Array.from(this._windows.keys())) {
			this.removeFromWindow(window);
		}
		this._windows.clear();
	},

	// Nettoie la sortie du modèle (retire d'éventuels blocs de code / espaces superflus).
	sanitize(raw) {
		let s = String(raw).trim();
		s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
		s = s.replace(/\n{3,}/g, "\n\n").trim();
		return s;
	}
};

// ---- Cycle de vie du plugin (Zotero 7) ----

function install() {}

async function startup({ id, version, rootURI }) {
	Annota.init({ id, version, rootURI });
	Annota.registerNotifier();

	// Exposé pour le script du panneau de préférences (prompt par défaut, reset).
	Zotero.Annota = Annota;

	Zotero.PreferencePanes.register({
		pluginID: "annota@equiriconi",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
		stylesheets: [rootURI + "preferences.css"],
		label: "Annota"
	});

	// Fenêtres déjà ouvertes au moment de l'activation du plugin.
	for (let window of Zotero.getMainWindows()) {
		Annota.addToWindow(window);
	}

	log("Started (v" + version + ")");
}

function onMainWindowLoad({ window }) {
	if (Annota) Annota.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	// Indispensable : conserver une référence à une fenêtre fermée fuirait.
	if (Annota) Annota.removeFromWindow(window);
}

function shutdown() {
	if (Annota) {
		Annota.unregisterNotifier();
		Annota.removeFromAllWindows();
	}
	try { delete Zotero.Annota; } catch (e) {}
	Annota = undefined;
}

function uninstall() {}
