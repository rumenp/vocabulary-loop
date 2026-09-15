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

- `public/vocabulary.json` contains the vocabulary metadata.
- `public/audio-manifest.json` maps words to generated filenames.
- `public/audio/` contains deployable recordings.

Audio is fetched once and stored as a blob in IndexedDB. Playlist selections,
repeat mode, and playback speed are persisted separately. This lets a listener
remove downloaded audio without losing a playlist.

## GitHub Pages

The repository workflow at `.github/workflows/deploy-player.yml` builds and
deploys this directory. In the repository settings, set **Pages → Source** to
**GitHub Actions**. Vite derives the repository base path during the Actions
build, so project Pages URLs work without hand-editing the configuration.

The deployed interface must continue to disclose that its narration is
AI-generated.
