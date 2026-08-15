# Annota (Zotero 7 / 8 / 9)

**Annota automates a prompt on every highlight: the text you highlight in the
PDF reader is sent to an LLM, and the response becomes the annotation's
comment** — on the fly, as soon as the highlight is created.

**You assign a prompt to each highlight color**, so a color can summarize,
another critique, another translate — and a color with no prompt is simply left
alone. Nothing is configured out of the box: Annota stays inert until you give
at least one color a prompt.

Ready-made prompts are collected in
[PROMPT-EXAMPLES.txt](PROMPT-EXAMPLES.txt), and Annota works with Mistral
(default) or any OpenAI-compatible endpoint.

### Example output (from the academic prompt in PROMPT-EXAMPLES.txt)

```
<b>Title.</b>
Concise paraphrase (2 to 5 sentences, ~80 words max).
<i>(Author, year, p.XX ; Author2, year)</i>
```

The third line (references) appears only if the passage explicitly cites
sources; a page number present in the passage ("Moulin, 1999, p.93") is kept
as-is. That behaviour comes from the prompt, not from Annota — write your own
and you get something else entirely.

## Installation

1. Build the package:
   ```bash
   ./build.sh
   ```
   (or zip `manifest.json`, `bootstrap.js`, `prefs.js`, `preferences.xhtml`,
   `preferences.js` at the root of a `.zip`, then rename it to `.xpi`).
2. In Zotero → **Tools → Add-ons** → gear ⚙️ →
   **Install Add-on From File…** → select `annota.xpi`.
3. Restart Zotero if prompted.

You can also download the `.xpi` directly from the
[Releases](../../releases) page.

### Automatic updates

Annota checks GitHub for new versions and updates itself — no manual
reinstall. Zotero polls periodically; you can also force a check via
**Tools → Add-ons → gear ⚙️ → Check for Updates**.

## Configuration

**Add-ons → Annota**, or **Preferences → Annota**. The panel has three tabs:
**🎨 Colors** (what each highlight color does — the only tab you need for a
manual setup), **✨ AI** (provider and what gets sent, used only by colors that
call the model) and **⚙️ General** (behaviour). Reference material — field types,
the variable list, advanced paths — sits in collapsible blocks so the everyday
view stays short.

### General
There is no global on/off switch: each color decides whether it runs
automatically or only on request (see **Prompt**), and a color with no prompt is
never touched. To stop all automatic generation, set your colors to *Only on
request*.

- **Also process underlines** — by default only highlights (`highlight`) trigger
  generation; this adds `underline`.
- **Overwrite an existing comment** — off by default (already-commented
  annotations are never touched).
- **⏳ while generating** — shows an indicator during the network call.

### AI provider
Pick one in the dropdown; only that provider's settings are shown.

| Provider | What it is |
|---|---|
| **Mistral / OpenAI-compatible** | Any remote `chat/completions` endpoint. Needs an API key (console.mistral.ai). |
| **Ollama (local)** | A model running on your own machine — no API key, no per-token cost, nothing leaves the computer. The model dropdown is read from your running Ollama (hit **Refresh** after `ollama pull …`). **Tags matter**: `llama3.1:8b` and `llama3.1` are different names, and only what is installed will answer. The first call after startup is slow while the model loads. |
| **Apple Intelligence (on-device)** | The model built into macOS 26+ — no API key, no cost, nothing leaves the Mac, ~1 s per call. Needs Apple Intelligence enabled and the Xcode Command Line Tools (`xcode-select --install`): Annota compiles a small Swift helper once on first use, since Apple exposes this model to native code only. |
| **Claude Code CLI (local)** | Runs `claude -p` using whatever your `claude` command is logged into (your subscription). Use the **absolute** path — Zotero doesn't see your shell PATH. A few seconds of cold start per call. |

**Temperature** (0–2, lower = steadier) applies to the two HTTP providers; the
Claude CLI ignores it.

### Text generation
- **Output language** — available in the prompt via `{{language}}`.
- **Max length** — available via `{{maxWords}}`.

### Document context
- **Send document context to the AI** — when enabled (default), the title,
  authors, year, publication, page and **abstract** of the source reference are
  sent along with the highlighted text. This helps the model situate the
  passage and resolve acronyms or ambiguous references. Empty fields are
  omitted.
- **Max abstract length** — abstracts are truncated to limit token usage
  (default 1200 characters; set 0 for no truncation).
- **Look up citations found in the passage** — when the highlighted text cites
  sources (`[1]`, `[2]`, `(Author, year)`, `Author (year)`), Annota resolves them
  to the actual bibliographic entries and passes them to the AI as
  `{{references}}`, so the model can name who is being cited instead of guessing.
  **Max references sent** caps how many entries go with each call (default 8).

  Two strategies, tried in order:
  1. **PDF links (reliable)** — the same mechanism behind Zotero's hover popup:
     the citation marker is a `/Link` annotation whose destination points at the
     bibliography entry, so Annota follows the link instead of guessing. Requires
     the PDF to be **open in a reader tab** (it is when you highlight) and the
     publisher to have embedded those links.
  2. **Text fallback** — if there is no link (or the PDF isn't open, e.g. bulk
     right-click from the library), Annota detects the citation markers and looks
     them up in the article's reference list extracted from the PDF text.

  If neither resolves, nothing is sent and the rest works exactly as before.

### Prompt
Above the prompt box is a row of **color swatches** — the same colors you use to
highlight in the reader, read straight from Zotero's own palette. Click one to
write that color's prompt.

- **A color with no prompt is never processed.** That is how you keep Annota off
  certain colors — leave them empty.
- A **green dot** marks the colors that are active.
- **Clear this color's prompt** switches a color back off.
- Everything is empty on a fresh install, so nothing happens until you set up at
  least one color. Copyable examples live in
  [PROMPT-EXAMPLES.txt](PROMPT-EXAMPLES.txt).

#### Custom fields — what you fill in by hand

Each color can define **fields you fill in yourself**. They appear **in the
text-selection popup** — the little window that shows up when you select text,
*before* the annotation exists. You type the values, then validate by picking a
highlight color as usual; the annotation is created with those values already
applied. Each field becomes a variable usable in the prompt *and* in the layout.

**Fields are independent of the AI.** As soon as a color has fields, the comment
is built from what you typed — no model call at all, even if a prompt is still
configured. The AI only steps in for a field of type `ai`, or if you put
`{{ai}}` in the layout.

One field per line — `name | Label | type | options | format`:

```
titre      | Titre                | text     | bold
paraphrase | Paraphrase           | textarea
reference  | Référence indirecte  | text     | italic
verifie    | Vérifié              | check
nature     | Nature               | select   | idée, méthode, résultat | italic
resume     | Résumé               | ai       | Résume le passage en une phrase.
```

Types: `text` (default), `textarea`, `check`, `select`, and `ai` (that field
alone is written by the model, following the instruction in the options column).
Formats: `bold`, `italic`, `bolditalic`, `underline`, `plain` (default) — the
format may sit in the 4th column when the field has no options.

With **no layout**, the comment is one line per field, in order, each wrapped in
its format. That gives `{{titre}}`,
`{{paraphrase}}`, `{{reference}}`, `{{verifie}}`, `{{nature}}`. Built-in variable
names are reserved and silently ignored if reused, so a field can never shadow
`{{text}}` or `{{comment}}`.

Combined with a layout that has no `{{ai}}`, this gives a **fully manual,
structured annotation** with no AI call at all:

```
<b>{{titre}}</b>
{{paraphrase}}
<i>{{reference}}</i>
```

Because the color isn't known while you type, the popup shows the **union** of
the fields declared across colors; only the fields of the color you finally pick
are applied. Values are used once, for the annotation you just created — they are
not stored afterwards.

#### Comment layout — mixing AI output with deterministic text

Each color has an optional **layout** applied after generation. Leave it empty
and the comment is just the AI's reply. Fill it in and you compose the comment
yourself: `{{ai}}` is the model's reply, every other variable is inserted
**verbatim** — not written by a model, so it can't be paraphrased or invented.

```
{{ai}}
<i>{{references}}</i>
```

That gives the AI note followed by the works cited in the passage, exactly as
found in the PDF. A line whose variables are all empty is dropped, so an
unresolved citation leaves no stray `<i></i>`.

Omit `{{ai}}` entirely and **no AI request is made at all** — the comment becomes
purely deterministic (and needs no API key or provider).

Each color also picks **when it runs**:
- **Automatically** — as soon as you create the highlight (the classic flow: the
  AI writes the note from the passage).
- **Only on request** — nothing happens on highlight; you write your own
  paraphrase by hand, then run the color later from the right-click menu so the
  AI only **formats or titles what you wrote** (see `{{comment}}`). This keeps
  the thinking yours.

**Variables** substituted at call time:

| Variable | Content |
|---|---|
| `{{text}}` | the highlighted text |
| `{{comment}}` | the note already in the annotation (your hand-written paraphrase) |
| `{{title}}` | title of the source document |
| `{{authors}}` | authors of the source document |
| `{{year}}` | year of the source document |
| `{{abstract}}` | abstract of the source document (truncated per settings) |
| `{{publication}}` | journal / book / proceedings |
| `{{page}}` | page of the highlighted passage |
| `{{references}}` | bibliographic entries for the works cited **inside** the passage |
| `{{maxWords}}` | the "max length" setting |
| `{{language}}` | the "output language" setting |

Two modes depending on the prompt:
- **Standard** (no `{{text}}` / `{{comment}}`) — your prompt acts as instructions,
  and the highlighted text (plus your existing note and the document context, if
  enabled) is appended automatically.
- **Advanced** (the prompt contains `{{text}}` or `{{comment}}`) — the prompt is
  sent as-is; you fully control the structure of the request.

## Running a prompt on one annotation

**In the PDF reader, right-click an annotation in the sidebar → Annota —
generate comment.** This targets exactly that annotation (or the several you
selected), instead of a whole document.

It always overwrites the existing comment, because that is the point of the
*Only on request* workflow: you write your paraphrase by hand, then ask the AI
to format or title it (`{{comment}}`). Colors with no prompt stay untouched.

## Generating comments after the fact

Highlights you made before installing Annota — or before changing your prompt —
can be processed in bulk. **Right-click a reference, an attachment, or a
selection of annotations** in your library and use the **Annota** submenu:

- **Generate missing comments** — only annotations that have no comment yet.
- **Regenerate all comments** — overwrites existing comments too.

Works on multiple selected items at once, with a progress indicator. This is an
explicit action, so it runs colors set to *Only on request* as well as automatic
ones, and each annotation uses the prompt of its own color. Highlights whose
color has no prompt are skipped and reported as such.

## How it works

- Listens to the `add` event of Zotero's notifier on annotation items.
- Processes only `annotationType` = `highlight` (+ `underline` if enabled), with
  non-empty text **and whose color has a prompt**; other highlights are ignored.
- Sends the text to the configured prompt, then writes the response into
  `annotationComment`. The reader updates on its own.
- Writing the comment triggers a `modify` event (not `add`), so there is no
  loop. An already-commented annotation (including one synced from another
  device) is not regenerated.

## Security

The API key is stored **in plain text** in the Zotero profile's preferences
(`extensions.zotero.annota.apiKey`). Do not share your profile.

## Development

- Per-color prompt resolution: `bootstrap.js` → `getPromptForColor()`
  (returns `""` when the color has no prompt, which means "skip").
- Annotation triggering / filtering: `bootstrap.js` → `handleItem()`.
- Source metadata lookup: `bootstrap.js` → `getContext()`.
- Request building (variables, modes): `bootstrap.js` → `buildMessages()`.

### Releasing

Bump `"version"` in `manifest.json`, then run:

```bash
./release.sh
```

It builds the `.xpi`, computes its SHA-256, regenerates `updates.json`, pushes,
and creates the GitHub release. The hash in `updates.json` **must** match the
released `.xpi` or Zotero will refuse the update — hence the script.
