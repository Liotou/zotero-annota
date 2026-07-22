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

**Add-ons → Annota**, or **Preferences → Annota**:

### General
- **Enable automatic generation** — master on/off switch.
- **Also process underlines** — by default only highlights (`highlight`) trigger
  generation; this adds `underline`.
- **Overwrite an existing comment** — off by default (already-commented
  annotations are never touched).
- **⏳ while generating** — shows an indicator during the network call.

### API connection
- **API key** — Mistral by default (get one at https://console.mistral.ai).
- **Model** — `mistral-large-latest` by default.
- **Endpoint** — API URL (chat/completions, OpenAI-compatible). Change it for a
  proxy or another compatible provider.
- **Temperature** — 0 to 2; lower = more deterministic (default 0.2).

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

**Variables** substituted at call time:

| Variable | Content |
|---|---|
| `{{text}}` | the highlighted text |
| `{{title}}` | title of the source document |
| `{{authors}}` | authors of the source document |
| `{{year}}` | year of the source document |
| `{{abstract}}` | abstract of the source document (truncated per settings) |
| `{{publication}}` | journal / book / proceedings |
| `{{page}}` | page of the highlighted passage |
| `{{maxWords}}` | the "max length" setting |
| `{{language}}` | the "output language" setting |

Two modes depending on the prompt:
- **Standard** (no `{{text}}`) — your prompt acts as instructions, and the
  highlighted text is appended automatically as the user message, preceded by
  the document context block if that option is enabled.
- **Advanced** (the prompt contains `{{text}}`) — the prompt is sent as-is; you
  fully control the structure of the request.

## Generating comments after the fact

Highlights you made before installing Annota — or before changing your prompt —
can be processed in bulk. **Right-click a reference, an attachment, or a
selection of annotations** in your library and use the **Annota** submenu:

- **Generate missing comments** — only annotations that have no comment yet.
- **Regenerate all comments** — overwrites existing comments too.

Works on multiple selected items at once, with a progress indicator. This is an
explicit action, so it runs even when automatic generation is turned off, and
each annotation uses the prompt of its own color. Highlights whose color has no
prompt are skipped and reported as such.

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
