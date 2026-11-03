# ChatGPT bridge: instructions for AI agents

You can generate images through the user's ChatGPT tab. Follow this exactly.

## Setup check (do this first)

1. Run `node --version`. It must be 18 or newer. No `npm install` is needed: there are no dependencies.
2. Run `node bridge/tabs.mjs`. It lists the ChatGPT tabs the extension sees.
   - **Empty list**: the user must do the install from README.md (load `extension/` in `chrome://extensions`, open chatgpt.com logged in). Ask them, then check again.
   - **No `★`** (no working tab chosen): ask the user which tab to use, then run `node bridge/tabs.mjs use <id>`. Never pick one of their other conversations on your own.
3. You never start the browser or open tabs yourself. The user's own browser does the work.

## Make an image

1. Write a job folder:
   ```
   job/
     prompt.txt      the full prompt (plain text)
     refs/           optional references, attached in name order: 1-….png, 2-….png
   ```
2. Run:
   ```bash
   node bridge/submit.mjs job out.png --topic <style>
   ```
   - Use **one topic per style** (e.g. `ui`, `characters`, `symbols`): the same topic reuses the same ChatGPT conversation, so the style stays consistent.
   - It prints the steps (`upload`, `generating`, `download`) and exits 0 with the image saved, or 1 with `ERREUR: …`.
   - It can take 1 to 3 minutes. Run it in the background and wait; do not poll the tab.
3. Several images: run the jobs **one after the other**. A loop in a shell script is fine. Never in parallel.
4. To fetch an image already in a conversation without generating: `node bridge/submit.mjs any-folder out.png --chat <url> --grab [--back N]`.

## Prompt tips that work
- Ask for a **plain flat light grey `#c8c8c8` background** when you need to cut the image out. Never ask for "transparent": you get a fake checkerboard.
- Give the exact format (e.g. "square 1:1", "portrait 2:3") and say what must not appear (text, watermark…).
- Refer to references by number ("reference 1"), in the order of the `refs/` files.

## When it fails
| Error | What to do |
|---|---|
| `no ChatGPT tab` / `Aucun onglet de travail choisi` | Ask the user to open chatgpt.com and choose the tab (extension icon, or `bridge/tabs.mjs use <id>`). |
| `ChatGPT answered without an image: …` | Read the quoted answer and fix the prompt (content refused, too vague). |
| `timeout: composer`, `timeout: …` | ChatGPT's interface changed. Tell the user the selectors in `extension/content.js` (`SEL`) need updating. |

Keep the volume low: this is the user's personal ChatGPT account.
