import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Howl } from "howler";
import type { AudioManifest, RepeatMode, VocabularyEntry } from "./types";
import {
  audioObjectUrl,
  cacheAudio,
  clearCachedAudio,
  defaultPreferences,
  getCachedWords,
  loadPreferences,
  requestPersistentStorage,
  savePreferences
} from "./storage";

const base = import.meta.env.BASE_URL;

function audioUrl(filename: string): string {
  return `${base}audio/${encodeURIComponent(filename)}`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function App() {
  const [words, setWords] = useState<VocabularyEntry[]>([]);
  const [manifest, setManifest] = useState<AudioManifest>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cached, setCached] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("All themes");
  const [repeat, setRepeat] = useState<RepeatMode>(defaultPreferences.repeat);
  const [rate, setRate] = useState(defaultPreferences.rate);
  const [nowPlaying, setNowPlaying] = useState<VocabularyEntry | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("Loading vocabulary…");
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const soundRef = useRef<Howl | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const queueRef = useRef<VocabularyEntry[]>([]);
  const indexRef = useRef(0);
  const playTokenRef = useRef(0);
  const repeatRef = useRef(repeat);
  const rateRef = useRef(rate);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [vocabularyResponse, manifestResponse] = await Promise.all([
          fetch(`${base}vocabulary.json`),
          fetch(`${base}audio-manifest.json`)
        ]);
        if (!vocabularyResponse.ok || !manifestResponse.ok) throw new Error("Unable to load vocabulary data");
        const vocabulary: VocabularyEntry[] = await vocabularyResponse.json();
        const audioManifest: AudioManifest = await manifestResponse.json();
        if (!cancelled) {
          setWords(vocabulary);
          setManifest(audioManifest);
          setStatus(`${vocabulary.length.toLocaleString()} words loaded`);
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Unable to load data");
      }

      try {
        const preferences = await loadPreferences();
        if (!cancelled) {
          setSelected(new Set(preferences.selected));
          setRepeat(preferences.repeat);
          setRate(preferences.rate);
        }
      } catch {
        // The player remains usable when private browsing disables IndexedDB.
      } finally {
        if (!cancelled) setHydrated(true);
      }

      try {
        const cachedWords = await getCachedWords();
        if (!cancelled) setCached(cachedWords);
      } catch {
        // Audio can still stream when persistent browser storage is unavailable.
      }
    })();

    return () => {
      soundRef.current?.unload();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    repeatRef.current = repeat;
    rateRef.current = rate;
    soundRef.current?.rate(rate);
    if (hydrated) {
      void savePreferences({ selected: [...selected], repeat, rate });
    }
  }, [selected, repeat, rate, hydrated]);

  const themes = useMemo(
    () => ["All themes", ...Array.from(new Set(words.map((entry) => entry.theme))).sort()],
    [words]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return words.filter(
      (entry) =>
        (theme === "All themes" || entry.theme === theme) &&
        (!needle ||
          entry.word.toLowerCase().includes(needle) ||
          entry.gloss.toLowerCase().includes(needle) ||
          entry.cluster.toLowerCase().includes(needle))
    );
  }, [words, query, theme]);

  const availableCount = Object.keys(manifest).length;
  const selectedAvailable = useMemo(
    () => words.filter((entry) => selected.has(entry.word) && manifest[entry.word]),
    [words, selected, manifest]
  );

  function releaseSound() {
    soundRef.current?.unload();
    soundRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }

  function finishQueue() {
    releaseSound();
    setIsPlaying(false);
    setNowPlaying(null);
    setStatus("Queue finished");
  }

  async function playAt(index: number) {
    const queue = queueRef.current;
    if (!queue.length) return;
    if (index >= queue.length) {
      if (repeatRef.current === "queue") index = 0;
      else return finishQueue();
    }
    if (index < 0) index = queue.length - 1;

    const token = ++playTokenRef.current;
    indexRef.current = index;
    const entry = queue[index];
    setNowPlaying(entry);
    setIsPlaying(false);
    setStatus(`Preparing ${entry.word}…`);
    releaseSound();

    try {
      const url = await audioObjectUrl(entry.word, audioUrl(manifest[entry.word]));
      if (token !== playTokenRef.current) return URL.revokeObjectURL(url);
      objectUrlRef.current = url;
      setCached((current) => new Set(current).add(entry.word));

      const sound = new Howl({
        src: [url],
        format: ["mp3"],
        html5: false,
        rate: rateRef.current,
        onplay: () => {
          setIsPlaying(true);
          setStatus(`Playing ${entry.word}`);
        },
        onpause: () => setIsPlaying(false),
        onend: () => {
          if (repeatRef.current === "word") void playAt(indexRef.current);
          else void playAt(indexRef.current + 1);
        },
        onloaderror: (_id, error) => {
          setStatus(`Could not load ${entry.word}: ${String(error)}`);
          setIsPlaying(false);
        },
        onplayerror: (_id, error) => {
          setStatus(`Could not play ${entry.word}: ${String(error)}`);
          setIsPlaying(false);
        }
      });
      soundRef.current = sound;
      sound.play();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Unable to play ${entry.word}`);
      setIsPlaying(false);
    }
  }

  function startQueue(queue: VocabularyEntry[], startWord?: string) {
    if (!queue.length) {
      setStatus("No generated audio exists for that selection yet");
      return;
    }
    queueRef.current = queue;
    const start = startWord ? Math.max(0, queue.findIndex((entry) => entry.word === startWord)) : 0;
    void playAt(start);
  }

  function togglePause() {
    const sound = soundRef.current;
    if (!sound) return;
    if (sound.playing()) sound.pause();
    else sound.play();
  }

  function stop() {
    ++playTokenRef.current;
    finishQueue();
    setStatus("Stopped");
  }

  function toggleWord(word: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  }

  async function downloadSelected() {
    const queue = selectedAvailable;
    if (!queue.length) return setStatus("Select at least one word with generated audio");
    await requestPersistentStorage();
    setDownload({ done: 0, total: queue.length });
    let done = 0;
    try {
      for (const entry of queue) {
        await cacheAudio(entry.word, audioUrl(manifest[entry.word]));
        done += 1;
        setDownload({ done, total: queue.length });
        setCached((current) => new Set(current).add(entry.word));
      }
      setStatus(`${done} recording${done === 1 ? "" : "s"} available offline`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownload(null);
    }
  }

  async function removeDownloads() {
    stop();
    await clearCachedAudio();
    setCached(new Set());
    setStatus("Downloaded audio removed");
  }

  return (
    <main>
      <header class="hero">
        <div>
          <p class="eyebrow">GRE vocabulary · listen deliberately</p>
          <h1>Vocabulary Loop</h1>
          <p class="lede">Choose the words worth remembering, then let repetition do its quiet work.</p>
        </div>
        <div class="library-stat">
          <strong>{words.length.toLocaleString()}</strong>
          <span>unique words</span>
          <small>{availableCount} recording{availableCount === 1 ? "" : "s"} ready</small>
        </div>
      </header>

      <section class="player-card" aria-label="Audio player">
        <div class="now-playing">
          <span>Now playing</span>
          <strong>{nowPlaying?.word ?? "Nothing yet"}</strong>
          <p>{nowPlaying?.gloss ?? "Select a playlist or audition an available word."}</p>
        </div>
        <div class="transport">
          <button class="icon-button" onClick={() => void playAt(indexRef.current - 1)} aria-label="Previous">←</button>
          <button class="play-button" onClick={togglePause} disabled={!nowPlaying}>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button class="icon-button" onClick={() => void playAt(indexRef.current + 1)} aria-label="Next">→</button>
          <button class="quiet-button" onClick={stop} disabled={!nowPlaying}>Stop</button>
        </div>
        <div class="playback-options">
          <label>
            Repeat
            <select value={repeat} onChange={(event) => setRepeat(event.currentTarget.value as RepeatMode)}>
              <option value="off">Off</option>
              <option value="queue">Playlist</option>
              <option value="word">Current word</option>
            </select>
          </label>
          <label>
            Speed
            <select value={rate} onChange={(event) => setRate(Number(event.currentTarget.value))}>
              {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((value) => <option value={value}>{value}×</option>)}
            </select>
          </label>
        </div>
        <p class="status" aria-live="polite">{status}</p>
      </section>

      <section class="toolbar" aria-label="Playlist controls">
        <div class="filters">
          <input
            type="search"
            placeholder="Search words or meanings…"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <select value={theme} onChange={(event) => setTheme(event.currentTarget.value)}>
            {themes.map((item) => <option value={item}>{item}</option>)}
          </select>
        </div>
        <div class="actions">
          <button onClick={() => setSelected(new Set(visible.map((entry) => entry.word)))}>Select visible</button>
          <button onClick={() => setSelected(new Set())}>Clear</button>
          <button class="primary" onClick={() => startQueue(selectedAvailable)}>
            Play selected ({selectedAvailable.length})
          </button>
          <button onClick={() => startQueue(words.filter((entry) => manifest[entry.word]))}>Play all available</button>
        </div>
        <div class="cache-actions">
          <span>{selected.size} selected · {cached.size} cached</span>
          <button onClick={() => void downloadSelected()} disabled={Boolean(download)}>
            {download ? `Downloading ${download.done}/${download.total}` : "Download selected"}
          </button>
          <button onClick={() => void removeDownloads()} disabled={!cached.size}>Remove downloads</button>
        </div>
      </section>

      <section class="word-list" aria-label="Vocabulary words">
        <div class="list-heading">
          <span>{visible.length.toLocaleString()} shown</span>
          <span>Selections are saved in this browser</span>
        </div>
        {visible.map((entry) => {
          const hasAudio = Boolean(manifest[entry.word]);
          return (
            <article class={`word-row ${selected.has(entry.word) ? "selected" : ""}`} key={entry.word}>
              <label class="word-check">
                <input
                  type="checkbox"
                  checked={selected.has(entry.word)}
                  onChange={() => toggleWord(entry.word)}
                />
                <span class="word-title">
                  <strong>{entry.word}</strong>
                  <small>{entry.pos} · {entry.theme}</small>
                </span>
              </label>
              <p>{entry.gloss}</p>
              <div class="row-actions">
                {cached.has(entry.word) && <span class="cached-badge">offline</span>}
                <button
                  class="audition"
                  disabled={!hasAudio}
                  title={hasAudio ? `Play ${entry.word}` : "Recording not generated yet"}
                  onClick={() => startQueue([entry], entry.word)}
                >
                  {hasAudio ? "Listen" : "Pending"}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <footer>
        <span>Voice: Matilda</span>
        <span>AI-generated narration</span>
        <span>{titleCase(repeat)} repeat</span>
      </footer>
    </main>
  );
}
