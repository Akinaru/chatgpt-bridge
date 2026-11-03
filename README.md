# ChatGPT bridge

Generate images in **your own ChatGPT tab** from a script or an AI agent (Claude Code, Codex…), with no copy-paste.

```
script / agent ──► local bridge (127.0.0.1:3777) ◄── browser extension (your chatgpt.com tab) ──► ChatGPT
```

- One image at a time, your account, your browser. Keep the volume low and reasonable.
- No dependency: Node 18+ and a Chromium browser (Chrome, Dia, Arc, Brave, Edge).
- The bridge only listens on `127.0.0.1`: nothing is exposed on the network.

## Install (2 minutes, once)

1. Download this repo:
   `git clone https://github.com/Akinaru/chatgpt-bridge.git`
2. Load the extension:
   1. In the browser, open `chrome://extensions`.
   2. Turn on **Developer mode**, top right.
   3. Click **Load unpacked**, then choose the `extension/` folder.
3. Open a tab on **https://chatgpt.com**, logged in. Leave it open.
4. Click the extension icon, then click the ChatGPT tab that should do the work. It gets a gold outline.

That's it.

## Use

```bash
node bridge/submit.mjs <job folder> <output.png> [--topic <name>] [--new]
```

The job folder contains:
- `prompt.txt`: the prompt;
- `refs/`: optional reference images, attached in name order (`1-…png`, `2-…png`).

The bridge starts by itself when needed. You can also run it with `node bridge/server.mjs`.

Options:

| Option | What it does |
|---|---|
| `--topic <name>` | Reuses the conversation of that topic, so ChatGPT keeps the context. Use one topic per style, for example `ui`, `characters`, `symbols`. |
| `--new` | Starts a new conversation. |
| `--chat <url>` | Uses that exact conversation. |
| `--grab [--back N]` | Downloads the last generated image of the conversation (or the N-th from the end) without generating. |

Without any option, the image is made in the conversation open in the chosen tab.

Example:
```bash
mkdir -p job/refs && echo "A cute cartoon cat, flat grey background" > job/prompt.txt
node bridge/submit.mjs job out.png --topic test
```

## The extension panel
Click the icon of the extension:
- **Working tab**: the ChatGPT tab that does the work. "Go" takes you to it, "+ New ChatGPT tab" opens one, "None" pauses everything.
- **Current job**: its step, the time elapsed, Cancel, and the queue.
- **Settings**:
  - thinking effort, Light, Medium or High (High by default);
  - a new conversation for every image;
  - opening a ChatGPT tab when none answers.
- **Topics and history**: the last images with thumbnails, and links to the image and to the conversation.

## What it handles by itself
- **References**: shrunk to 1600 px before upload; it waits until they are attached.
- **Thinking effort**: set before each send.
- **The result**: detected by ChatGPT's own label ("Generated image"), so a reference is never taken for the result.
- **ChatGPT answers with text instead of an image** (asks for the files, asks a question, "image generation failed"):
  1. it re-attaches the files, clicks "Try again" or answers "go on";
  2. it does this 2 times at most, then the job fails with ChatGPT's answer.

  Nothing stays blocked.
- **Guards**:
  - no tab answers: a warning after 20 s, the job is cancelled after 3 min;
  - a job with no answer: it fails after 10 min.

Data lives in `~/.aki-chatgpt/`:
- `history.json`: the history;
- `images/`: the images;
- `chats.json`: the topics;
- `settings.json`: the settings;
- `worker.json`: the working tab.

## When ChatGPT changes its interface
All the selectors are at the top of `extension/content.js`, in the `SEL` object. Fix them, then click **↻** on the extension in `chrome://extensions`. Open tabs pick up the new version by themselves.

## For AI agents
See [AGENTS.md](AGENTS.md).

## Note
This drives the ChatGPT web app with your own account. OpenAI's terms restrict automated use of the web app: use it for a low, personal volume. For volume, use the official OpenAI API.
