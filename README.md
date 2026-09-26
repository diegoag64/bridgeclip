<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/bridgeclip-logo.svg" />
    <img src="resources/bridgeclip-logo-light.svg" alt="BridgeClip" height="56" />
  </picture>
</p>

<h3 align="center">Turn long videos into captioned short-form clips, on your own computer.</h3>

<p align="center">
  An open-source AI clipping app from <a href="https://www.bridgemind.ai">BridgeMind</a>.
  Drop in a podcast, stream, YouTube link or Twitch VOD link, and BridgeClip finds the strongest moments,
  cuts them to 9:16 or 16:9, and burns in word-by-word captions.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/bridge-mind/bridgeclip/releases"><img src="https://img.shields.io/github/v/release/bridge-mind/bridgeclip?label=download" alt="Latest release" /></a>
  <a href="https://www.bridgemind.ai/discord"><img src="https://img.shields.io/badge/Discord-builders-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

---

## Why BridgeClip?

- **No BridgeMind account or backend.** BridgeClip runs on your machine and calls OpenRouter directly with your own provider accounts and keys. Optional social account connections use your Zernio account and API key. Your videos and keys do not pass through a BridgeMind server.
- **Pay only for what you use.** Transcription and clip planning bill your OpenRouter account at their prices. Rendering happens locally with FFmpeg. BridgeClip shows estimated API cost when the providers return usable usage data.
- **Captions that look native.** Nine styles (Viral, Hormozi, Bold, Clean, Minimal, Fire, Glow, Neon, Karaoke), each with a live preview before you render.
- **MIT licensed.** Fork it, change it, ship it.

## How it works

```
 Source video ──▶ Download ──▶ Transcribe ──▶ Find moments ──▶ Render
 (file or link)    yt-dlp      OpenRouter      OpenRouter        FFmpeg
                           MAI Transcribe 2    LLM ranks the     crop, captions,
                               word timings    best moments      one file per clip
```

Every run gets its own folder. The **Library** shows completed clips with virality scores, timecodes and tags. **Jobs** shows what is running or queued right now (up to two clipping runs go at once; more wait in a queue) and every earlier run, including completed, failed, cancelled and interrupted jobs; completed runs open directly in Library, and failed runs from this session can run again. Each previous job has a three-dot menu for **Open in Library** (or **Open job** for session jobs), **Open folder** and **Details**. Details opens the saved transcript and edit trace, including for failed runs. Older runs without a saved status appear as unfinished. You can optionally connect social accounts through Zernio to publish or schedule a selected clip.

Inside a Library run, the YouTube icon beside **Inspect transcript & edits** opens the original video in your browser when a YouTube source link is saved. **Not Posted** and **Posted** are independently collapsible sections with clip counts. **Not Posted** opens by default and appears first; **Posted** starts collapsed below it. Selection applies only to expanded sections. Badges distinguish scheduled, publishing, partially posted and failed posts using this workspace’s saved posting history. Clip actions sit below the preview, with tooltips for posting, adding to an automation and opening the folder. The post dialog can enhance platform-specific titles, captions and tags using the same transcript, source context and optional research as Automations; review and apply the draft before posting.

Library overview cards show the total clip count at the top left and separate **Posted** / **Not Posted** counts below the title. Star a run to keep it at the top; favorites persist across restarts. The trash action asks for confirmation before permanently deleting the run folder, all clips and other files inside it, and cached clip previews. It does not remove published social posts or copies stored elsewhere. Active runs cannot be deleted.

In **Automations**, drag a queued clip’s handle to change its order, or focus the handle and use the Up/Down arrow keys. Submitted or uncertain items stay in place. The bank separates **Queued**, **Needs attention** (when needed), and **Submitted** clips. Hover or focus each row’s info icon for its added/submitted timestamps, source, caption and metadata status. Use the actions menu to edit a bank item or **Remove from queue**, and **View in Library** to open its source run. Submitted clips have no removal option. Removing a queued clip leaves the original file intact. Reviewed metadata is marked **Enhanced** in the info tooltip and hides the Enhance button; selecting a platform that still needs metadata makes enhancement available again.

In **Create → Clips**, choose **Quality**, **Economy**, or **Advanced**. Advanced offers searchable OpenRouter model pickers for transcription and clip planning, with model IDs, planning prices and compatibility notes. Both selections are required and appear in Review. Advanced retries the selected models without automatically switching models. Transcription must provide word timestamps; planning must support structured output. See [model selection and transcription](docs/transcription.md).

In **Create → Format → Video speed**, choose **1×** (normal), **1.1×**, **1.25×**, **1.5×**, **1.75×**, or **2×** for every clip in the job. Exports preserve voice pitch and keep captions synchronized. Speed works with **Cut dead air** and appears in Review and the saved results. Clip lengths and source trim times refer to the original footage: a 60-second clip at 1.5× exports in about 40 seconds, before any dead-air cuts. The choice stays selected when you clip another video in the same session. Existing exports stay as they are; generate a new job to change their speed.

## Download

**macOS** (Apple silicon and Intel): download BridgeClip from [bridgeclip.ai](https://www.bridgeclip.ai) or [Releases](https://github.com/bridge-mind/bridgeclip/releases), open the disk image and drag BridgeClip to Applications. Builds are signed with BridgeMind's Developer ID and notarized by Apple, and bundle Python, FFmpeg and yt-dlp. **Windows and Linux** packages are coming soon; until then, use the development setup below. See [release status and verification](docs/RELEASING.md).

BridgeClip keeps itself up to date. It checks [Releases](https://github.com/bridge-mind/bridgeclip/releases) shortly after launch and every four hours, downloads a new version in the background, and installs it when you choose **Restart to update** (in the sidebar or **Settings → About**) or the next time you quit. macOS only installs an update signed by the same developer, and every download is checked against the SHA-512 published with the release. Copies run from source, local package builds and apps opened straight from the disk image don't update themselves; **Settings → About** says why. To turn updates off, start BridgeClip with `BRIDGECLIP_DISABLE_AUTO_UPDATE=1`.

On first launch, paste your OpenRouter key into the setup card:

| Provider | Used for | Get a key |
| --- | --- | --- |
| OpenRouter | MAI Transcribe 2 transcription, clip selection, and Jev editorial review | [openrouter.ai](https://openrouter.ai/keys) |

Keys are encrypted with your operating system's secure storage. If secure storage is unavailable, BridgeClip asks you to configure or unlock it before saving keys.

### What leaves your computer

For a link, the app downloads the source using your network connection. Audio for MAI Transcribe 2 (Quality), Whisper Turbo (Economy), or your selected transcription model (Advanced) goes to OpenRouter. Transcription retries temporary failures and uses fallback models when needed; Economy tries Whisper Large V3 before MAI. Transcript text for clip planning also goes to OpenRouter. If the video has no audio or no speech, BridgeClip samples video frames and sends those images to OpenRouter for visual-only planning. Clips made through that fallback have no speech captions. Economy skips optional AI layout checks. If you connect social accounts, BridgeClip sends your Zernio API key to Zernio and receives account/profile metadata; platform sign-in occurs in your browser. When you choose **Post** or **Schedule**, BridgeClip uploads that clip to Zernio's media storage and sends its caption, selected accounts and publishing options to Zernio. Zernio then publishes to those platforms. Provider accounts, charges, retention and data policies are governed by those services.

**Jev editorial review via OpenRouter** in Settings uses your existing OpenRouter key and is on by default for new runs. No separate TypeSafe key or account is required. New clips require a successful coherence review; turning review off prevents automatic clip generation. Bounded transcript excerpts, titles, and diagnostic text go through OpenRouter to Jev; Jev receives no audio, video, or images. **Additional visual context** is a separate opt-in: sampled source frames go to OpenRouter and their descriptions can go to Jev. It adds provider cost, with at most eight context-vision requests per job and twelve frames per request. These limits are independent of ordinary framing vision. Saved editorial traces contain the excerpts, judgments, probabilities, model/version, and reported usage or cost estimates. Review them before sharing a run folder.

Downloads and intermediate media are held in a private `work/` directory under BridgeClip’s per-user application data folder. BridgeClip removes job work on completion, failure, and cancellation, and clears stale work when it next starts after a forced shutdown. A local video you selected stays where it was. Rendered clips, the transcript, plan and `job_output.json` remain in a run folder under your chosen **Output folder** (by default, `~/BridgeClip`). That JSON includes the source URL or local path and video title. Delete the run folder to remove those local outputs.

Settings, the last synced list of connected accounts (platforms, handles and Zernio IDs), local posting history, and upload retry records live in Electron's per-user application data folder. Posting history can include clip paths and titles, account handles, targets, status and links; retry records can include a clip path and an uploaded media URL. Changing or removing the Zernio key switches to a separate local post history and quarantines the old account and upload retry caches. Returning to the same key restores its saved post history; a newly rotated key has separate history. Quarantined copies remain on disk until a later cleanup after 30 days; to erase them immediately, quit the app and delete the `zernio-*.quarantine-*` files from its application data folder. Key changes do not delete media or posts already held by Zernio or a social platform. Diagnostic logs live in the per-user logs folder. Remove provider keys in Settings to clear their encrypted saved copies, and review logs before sharing them in an issue.

Only download or clip material you have permission to use. Remote sites may limit downloads or change their access rules.

### Clip a Twitch VOD

Paste a public, completed Twitch video link such as `https://www.twitch.tv/videos/1234567890` into Create, then choose your clip settings and generate. BridgeClip downloads the saved video and uses the same transcription, AI moment selection and rendering flow as other sources. Links on `twitch.tv`, `www.twitch.tv`, `m.twitch.tv` and `go.twitch.tv` are accepted and normalized to the canonical video URL.

Live channels, Twitch clips, collections, subscriber-only videos and deleted or expired VODs are not supported. No Twitch login or cookies are used. The original source must be at most six hours and 20 GB. BridgeClip downloads the full source before applying the optional start and end times; a link's timestamp or tracking parameters are ignored. For a longer source, trim a downloaded file before adding it. Downloads also stop after four hours or when less than 1 GB of free space would remain.

## Develop

Local macOS runs apply the BridgeClip Dock icon when the window appears and when the app is activated. Restart Electron after changing startup code; refreshing the renderer only updates the UI.

**Prerequisites:** Node.js 22, Python 3.12, and FFmpeg with the libass-backed `ass` filter for captions. The clipping engine, model, fonts, and locked Python dependencies are included in this repository. In development, BridgeClip uses FFmpeg from `engine-bin/` when it exists, then falls back to your `PATH`. Provider keys are needed for live jobs, not tests.

```bash
git clone https://github.com/bridge-mind/bridgeclip
cd bridgeclip
python3.12 -m venv engine/.venv
engine/.venv/bin/pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

BridgeClip finds its in-repo engine and virtual environment automatically. **Settings → System check** shows the Python, yt-dlp, FFmpeg, and engine checks; set **Python path** in development if you use another interpreter.

On Linux, use system FFmpeg with the libass-backed `ass` filter (`ffmpeg -hide_banner -filters | grep -E '[[:space:]]ass[[:space:]]'`) and Python 3.12. Arch: `sudo pacman -S ffmpeg`. Skip `scripts/prepare-resources.sh` during development; it prepares macOS release resources. Linux development and tests are supported, but a self-contained Linux package is not yet available.

For experimental Windows development, install Python 3.12 and FFmpeg with the `ass` filter on `PATH`, then use PowerShell:

```powershell
python -m venv engine/.venv
engine/.venv/Scripts/python.exe -m pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

The in-repo Windows virtual environment is detected automatically. Native Windows CI checks the engine, desktop modules, renderer, and production build. Tests that create file symlinks report a skip if Windows denies symlink creation; they run when the account has the required capability. Release-helper tests use Git Bash. The private release pipeline includes Windows installers; a real signed upgrade must pass acceptance before update support is claimed.

Private release workflows package the in-repo engine and media tools for macOS, Windows, and Linux. For local packaging, first run `bash scripts/prepare-resources.sh arm64` (or `x64` on Intel), then follow [the release guide](docs/RELEASING.md). Signing credentials are still required for a distributable build.

### First run and troubleshooting

1. Add your OpenRouter key in the setup card. A saved key is never shown again; paste a new one to replace it or choose **Remove key** in Settings.
2. Run **Settings → System check**. In development, set the Python path if your local virtual environment is not detected.
3. Choose a local video with the file picker or paste a public video link, select clip lengths, framing, and caption style, then start. Smart framing automatically follows faces and arranges screen shares with facecams shot by shot. The optional AI vision check improves ambiguous layouts and can add OpenRouter cost. Dropping a local file opens the picker so you can grant access. Completed runs appear in Library and in your output folder.

4. If a link fails, check it in a signed-out browser or download it yourself and select the local file. If a run fails, use the in-app error and System check first; logs intentionally omit raw provider responses and private source details.

To investigate a crop, enable **Capture framing diagnostics** in the Format step before generating, then choose **Inspect framing** on a completed clip. Capture is off by default. The inspector shows the uncropped source, synchronized output, toggleable face/subject/region/crop overlays, and a timeline of layout changes, AI image selections, and removed intervals. Detection samples are recorded at 4 fps, with their timestamps shown; they are not per-frame detections. Removed source intervals have no corresponding output frame.

### Review & edit

Choose **Review & edit** on Create’s first step to find candidates without rendering them. BridgeClip researches the source, transcribes it, proposes moments and suggests framing. It opens a saved editor project when discovery finishes. The automatic workflow remains available.

Reopening a Library item goes straight to the editor when it has unfinished candidates and no baked clips. Once there are baked clips, it opens their list with a prominent **Continue editing** button and a count of clips left to finish. When every candidate is baked or discarded, the list keeps a quieter **Open editor** button. The editor starts on an unfinished candidate, falling back to a baked one before any discarded candidates.

Library cards with unfinished candidates show a blue **Editing** badge, the number left to finish and a matching border, even if some clips are already baked. The indicator clears once every candidate is baked or discarded.

- Review every candidate’s **Jev** questions, probabilities, thresholds and criteria, including candidates that need attention. Nothing is discarded or repaired automatically in this workflow. Disabled, unavailable or incomplete reviews are shown as unrated, never as passes.
- Watch the source beside the output framing. Drag trim handles or enter timecodes, split at the playhead and remove unwanted sections. **Play cuts only** previews the retained sequence; turn it off to inspect surrounding context. The **Transcript** tab follows the active caption during playback; pause to browse freely. Space plays/pauses, I/O sets the outer trim, S splits, and arrow keys step through frames.
- Choose **Full frame**, **Split** or **Fit**. Drag inside a crop rectangle to move it, or drag any corner to resize it with the opposite corner anchored. Corners preserve the crop’s proportions and stay within the source; split layouts have independent handles for each panel. Arrow keys adjust a focused corner (Shift for larger steps). Position and zoom controls remain available. Add a layout change at the playhead to reframe another section, or apply one layout to the whole clip. Edit **Layout starts** or drag its diamond on the timeline to move an existing change; arrow keys nudge a focused diamond by 0.1 seconds (Shift: 1 second). Changes stay between their neighbours, with undo and autosave support. Enable **Smooth movement** on a new layout to ease from the preceding crop, including zoom, in both preview and export. Adjust its duration from 0.1–5 seconds of source time. Movement works between matching Full frame or Split layouts; changes between layout types use a cut.
- Drag either edge of a timeline section to trim or extend it. **Full source** zooms out for larger adjustments. Turn off **Play cuts only**, watch beyond the current selection, then choose **Extend to playhead** to extend its ending (or its beginning when the playhead is before the clip). Adjacent cuts and the source’s bounds limit each edge; edits support undo and redo.
- Re-run Jev after editing. The previous review is marked out of date after changes to the title, cuts or framing. Internal removals receive their own safety and join questions. These reviews advise you; you decide when a clip is ready, including when a review raises concerns. Jev continues to review the source dialogue and your cuts; caption corrections do not rewrite that evidence.
- Clips start in **Refining**. **Discard** sets one aside in a collapsible group; **Restore clip** brings it back. Choose **Mark ready** when satisfied, then **Bake captions** (or **Render clip** with captions off). A successful render moves the candidate to **Baked**. Further changes return it to Refining. Discarding a candidate never deletes earlier exports.
- Click a pencil in **Transcript** to correct a line while reviewing. Corrections autosave for this candidate only, support undo, and appear in its final video. **Reset text** restores the source line; clearing a line hides its caption without removing audio. Corrections keep word timestamps when the word count matches; otherwise new words are spread over that line’s spoken interval.
- Select a caption style and playback speed before baking. Captions are timed to the retained footage and baked into the final video; the live output preview shows framing; caption text can be reviewed and edited in **Transcript**. Each export becomes a new Library clip, preserving earlier exports. Titles are clip metadata, not automatic title-card overlays.

Edits autosave and reopen from Jobs or Library. Review projects retain an independent full-resolution source copy, a smaller playback preview, the transcript and the project file in the run folder. These need additional disk space and remain until the Library item is deleted. Existing automatic runs remain inspectable; start a new Review & edit run to create an editable project. Rendering is local; discovery and **Review again** use the configured providers and can incur API costs.

**Before transcription**, Gemini 3.8 Flash builds a brief from the video title, description, channel and upload date. Web research runs for each YouTube or Twitch source by default, with up to two searches and four cited sources through OpenRouter. It separates a channel overview from the likely format of this video (reaction, interview, tutorial, etc.), suggests what to look for, and records uncertainties. Turn off **Research the source before clipping** in Settings to use metadata only. Local files are not searched. Research failures fall back to metadata; they never fabricate citations or block transcription. This adds provider time and cost.

The brief accompanies discovery, boundary repairs and cut review. The planner must confirm or revise its assumptions against the transcript; background research cannot supply missing speech, setup or payoff. Only terms already present in the metadata can become transcription hints, and your custom vocabulary takes priority. This stage researches public metadata and web sources; it does not claim to watch an entire YouTube video through Gemini.

The pipeline transcribes the **entire source**, even when you select a preferred range. That range and the selected clip durations guide discovery; they are not hard cut boundaries. Quality uses GPT-6 Sol to propose complete ideas and repair their boundaries, extending earlier or later to include setup, qualifications and payoff. Economy uses GLM 5.3 Flash planning and Gemini 3.8 Flash repairs. This can increase transcription cost compared with transcribing only a selected range.

In the automatic workflow, Jev reviews each clip independently: standalone meaning and title support must reach 70%; faithfulness must reach 65%; opening context, ending and logical flow must each reach 75%; confidence that the segment is not sponsored must reach 80%; and sufficient evidence must reach 50%. Every actual internal removal needs 0.95 approval for safety and a logical join. Uncertain removals are restored, then the complete edited sequence is checked again before rendering. Changed timing in a rendering fallback requires approval too. Discovery records a topic and source-anchored setup/payoff for each candidate and preserves speaker turns through review. Rejected candidates may trigger one additional search of underexplored sections (up to eight new candidates); overlapping alternatives are selected after approval. Repairs must cite an actual source passage to explain the proposed change. There are at most two boundary repairs per candidate; unavailable or inconclusive review omits the candidate. A run may produce fewer clips or none. These are fixed acceptance rules over probabilistic model judgments, not a guarantee of semantic correctness. Clips without a usable speech transcript currently cannot pass.

Use **Inspect transcript & edits** in a clip list, or **Details** in a Jobs row’s three-dot menu. The compact Details popup keeps its header and navigation visible while you browse **Jev review**, **Transcript** and **Run details**. Jev review shows the actual questions, probabilities and per-check pass/fail thresholds for each saved evaluation, with expandable criteria and input evidence. Transcript shows searchable passages, original and repaired boundaries, retained/omitted speech and repair decisions. Run details contains the source context and planner requests. Saved JSON throughout the review and framing screens uses a color-coded, expandable viewer that also formats JSON stored inside strings. Long responses load more text or entries on demand; **Original** preserves the saved values and offers **Select all** for copying. Reopening makes no AI calls. New runs show a **Source context** section with the channel overview, likely format, research sources and uncertainties. They save `source_context.json` before transcription and include it in `edit_audit.json` independently of framing capture; older runs can show their transcript but cannot reconstruct missing decisions. These files contain source text: review them before sharing. Editorial scores and semantic duplicate comparisons remain advisory; **Editorial** sorting reweights saved scores locally.

Editorial evidence is saved even when full framing capture is off. **Inspect framing** then shows the saved review and generated clip without a source preview. Turn on framing capture for synchronized source playback and protection/prevented-cut timeline bands. Existing clips must be regenerated to use the new decisions.

Capture keeps one lower-resolution copy of the **entire source video** (including audio) per run, shared by its clips, plus a recorded trace for each clip. It adds processing time and disk usage. These files stay in the run’s output folder after temporary media is cleaned up; delete that run folder to remove them, or delete `framing-source.mp4` to keep only the traces. Opening an inspector makes no AI calls and works after restarting the app. Older clips without traces show an unavailable message; missing previews leave the recorded decisions usable. The inspector is read-only and does not change thresholds or re-render clips.

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run typecheck` | Type-check the main process and renderer |
| `npm run lint` | Check TypeScript and JavaScript source with ESLint |
| `npm run build` | Production build into `out/` |
| `npm run test:bridge` | Run Python bridge regression tests |
| `engine/.venv/bin/python -m pytest -q engine/tests` | Run the clipping engine tests after installing pytest |
| `npm run test:release` | Check complete release artifacts and updater metadata |
| `npm run test:renderer` | Check renderer state and parsing regressions |
| `npm run test:main` | Check desktop security and pipeline regressions |
| `npm run test:zernio` | Check social account, upload and posting flows against local mocks |
| `npm run dist:mac` | Package the current Mac architecture into `dist/` after preparing matching resources (signing needs a Developer ID) |
| `npm run icons` | Export app icons from the imagegen master `resources/bridgeclip-icon.png` (macOS; see `scripts/icon/README.md`) |

### Project layout

```
src/main/        Electron main process: settings, pipeline runner, IPC, optional Zernio posting
src/preload/     The typed window.bridgeclip API exposed to the renderer
src/renderer/    React UI (Create, Library, Jobs, Accounts, Posts, Automations, Settings)
src/shared/      Product constants shared by main and renderer
bridge/          Python worker protocol and network guard
engine/          BridgeClip clipping engine, assets, locked Python dependencies, and tests
scripts/icon/    Icon and logo generators
```

The visual system (tokens, components and rules) is documented in [DESIGN.md](DESIGN.md).
The desktop trust boundaries and bridge protocol are described in [Architecture](docs/ARCHITECTURE.md).
The [open-source readiness checklist](docs/OPEN_SOURCE_READINESS.md) tracks the remaining release gates and maintenance priorities.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, review expectations and checks. Security reports should follow [SECURITY.md](SECURITY.md), not a public issue. The community guidelines are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © BridgeMind
