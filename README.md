# Annota (Zotero 7 / 8 / 9)

**Annota automates a prompt on every highlight: the text you highlight in the
PDF reader is sent to an LLM, and the response becomes the annotation's
comment** — on the fly, as soon as the highlight is created.

The prompt is entirely yours. Summaries, plain-language explanations,
translations, key-point extraction, formatted academic notes… you decide what
the model produces. **Built-in presets** are provided to get started, and it
works with Mistral (default) or any OpenAI-compatible endpoint.

### Example: the "Academic note" preset (shipped as the default)

```
<b>Title.</b>
Concise paraphrase (2 to 5 sentences, ~80 words max).
<i>(Author, year, p.XX ; Author2, year)</i>
```

The third line (references) appears only if the passage explicitly cites
sources; a page number present in the passage ("Moulin, 1999, p.93") is kept
as-is. This is just one preset — replace it with your own at any time.

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

### Prompt
The prompt field is the heart of Annota. An **"Insert a preset"** menu offers
starting points (academic note, summary, plain-language explanation, key points,
translation); selecting a preset fills the field, which you can then edit
freely. **"Restore default preset"** brings back the academic preset.

**Variables** substituted at call time:

| Variable | Content |
|---|---|
| `{{text}}` | the highlighted text |
| `{{title}}` | title of the source document |
| `{{authors}}` | authors of the source document |
| `{{year}}` | year of the source document |
| `{{maxWords}}` | the "max length" setting |
| `{{language}}` | the "output language" setting |

Two modes depending on the prompt:
- **Standard** (no `{{text}}`) — your prompt acts as instructions, and the
  highlighted text is appended automatically as the user message.
- **Advanced** (the prompt contains `{{text}}`) — the prompt is sent as-is; you
  fully control the structure of the request.

## How it works

- Listens to the `add` event of Zotero's notifier on annotation items.
- Processes only `annotationType` = `highlight` (+ `underline` if enabled), with
  non-empty text.
- Sends the text to the configured prompt, then writes the response into
  `annotationComment`. The reader updates on its own.
- Writing the comment triggers a `modify` event (not `add`), so there is no
  loop. An already-commented annotation (including one synced from another
  device) is not regenerated.

## Security

The API key is stored **in plain text** in the Zotero profile's preferences
(`extensions.zotero.annota.apiKey`). Do not share your profile.

## Development

- Prompt presets and default prompt: `bootstrap.js` → `Annota.PRESETS`.
- Annotation triggering / filtering: `bootstrap.js` → `handleItem()`.
- Request building (variables, modes): `bootstrap.js` → `buildMessages()`.
