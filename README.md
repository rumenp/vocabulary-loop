# Vocabulary Loop

A static, installable vocabulary audio player for the 1,019-word collection.

## Local development

```sh
npm install
npm run dev
```

Build and inspect the production output with:

```sh
npm run build
npm run preview
```

## Content

- `content/word-lessons.json` contains the mnemonic and example for every word.
- `content/word-lessons.txt` is the review-friendly version with meanings included.
- `public/vocabulary.json` contains the vocabulary metadata.
- `public/audio-manifest.json` maps words to generated filenames.
- `public/audio/` contains deployable recordings.

The recordings use Deepgram's `aura-2-athena-en` voice at 0.9× synthesis
speed. Generation is resumable and reads the API key only from the process
environment:

```sh
DEEPGRAM_TEST_KEY=... python3 scripts/generate-deepgram-audio.py
```

Audio is stored in the browser's Cache Storage, while playlist selections,
repeat mode, and playback speed are persisted separately in IndexedDB. This
lets a listener remove downloaded audio without losing a playlist.

Playback uses one persistent native HTML audio element rather than Web Audio.
The next recording is cached while the current recording plays, and the Media
Session API supplies supported phone lock screens with title, play/pause,
previous, next, and stop controls. This arrangement is designed to preserve one
continuous media session while an iPhone screen is locked.

## GitHub Pages

The repository workflow at `.github/workflows/deploy-player.yml` builds and
deploys this directory. In the repository settings, set **Pages → Source** to
**GitHub Actions**. Vite derives the repository base path during the Actions
build, so project Pages URLs work without hand-editing the configuration.

The deployed interface must continue to disclose that its narration is
AI-generated.
