import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AudioManifest, RepeatMode, VocabularyEntry } from "./types";
import {
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<VocabularyEntry[]>([]);
  const indexRef = useRef(0);
  const playTokenRef = useRef(0);
  const repeatRef = useRef(repeat);
  const rateRef = useRef(rate);
  const mediaActionsRef = useRef({
    play: () => {},
    pause: () => {},
    previous: () => {},
    next: () => {},
    stop: () => {}
  });

  useEffect(() => {
    let cancelled = false;
    let loadedManifest: AudioManifest = {};

    void (async () => {
      try {
        const [vocabularyResponse, manifestResponse] = await Promise.all([
          fetch(`${base}vocabulary.json`),
          fetch(`${base}audio-manifest.json`)
        ]);
        if (!vocabularyResponse.ok || !manifestResponse.ok) throw new Error("Unable to load vocabulary data");
        const vocabulary: VocabularyEntry[] = await vocabularyResponse.json();
        const audioManifest: AudioManifest = await manifestResponse.json();
        loadedManifest = audioManifest;
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
        const cachedWords = await getCachedWords(loadedManifest);
        if (!cancelled) setCached(cachedWords);
      } catch {
        // Audio can still stream when persistent browser storage is unavailable.
      }
    })();

    return () => {
      const audio = audioRef.current;
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    repeatRef.current = repeat;
    rateRef.current = rate;
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = rate;
      audio.loop = repeat === "word";
    }
    if (hydrated) {
      void savePreferences({ selected: [...selected], repeat, rate });
    }
  }, [selected, repeat, rate, hydrated]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const handlers: Array<[MediaSessionAction, () => void]> = [
      ["play", () => mediaActionsRef.current.play()],
      ["pause", () => mediaActionsRef.current.pause()],
      ["previoustrack", () => mediaActionsRef.current.previous()],
      ["nexttrack", () => mediaActionsRef.current.next()],
      ["stop", () => mediaActionsRef.current.stop()]
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some Safari versions expose Media Session but omit individual actions.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported actions during teardown.
        }
      }
    };
  }, []);

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

  function releaseAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.loop = false;
    audio.removeAttribute("src");
    audio.load();
  }

  function finishQueue() {
    releaseAudio();
    setIsPlaying(false);
    setNowPlaying(null);
    setStatus("Queue finished");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
  }

  function nextIndex(index: number): number | null {
    const queue = queueRef.current;
    if (index + 1 < queue.length) return index + 1;
    return repeatRef.current === "queue" && queue.length ? 0 : null;
  }

  function preloadFollowing(index: number) {
    if (repeatRef.current === "word") return;
    const followingIndex = nextIndex(index);
    if (followingIndex === null) return;
    const following = queueRef.current[followingIndex];
    void cacheAudio(following.word, audioUrl(manifest[following.word]))
      .then(() => setCached((current) => new Set(current).add(following.word)))
      .catch(() => {
        // Playback will surface a useful error if the next recording is unavailable.
      });
  }

  function updateMediaSession(entry: VocabularyEntry) {
    if (!("mediaSession" in navigator)) return;
    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: entry.word,
        artist: "Vocabulary Loop · Matilda",
        album: entry.gloss
      });
    }
    navigator.mediaSession.playbackState = "playing";
  }

  function playAt(index: number) {
    const queue = queueRef.current;
    if (!queue.length) return;
    if (index >= queue.length) {
      if (repeatRef.current === "queue") index = 0;
      else return finishQueue();
    }
    if (index < 0) index = queue.length - 1;

    ++playTokenRef.current;
    indexRef.current = index;
    const entry = queue[index];
    setNowPlaying(entry);
    setIsPlaying(false);
    setStatus(`Preparing ${entry.word}…`);

    const audio = audioRef.current;
    if (!audio) {
      setStatus("Audio player is unavailable");
      return;
    }
    audio.pause();
    audio.loop = repeatRef.current === "word";
    audio.playbackRate = rateRef.current;
    audio.src = audioUrl(manifest[entry.word]);
    audio.load();
    updateMediaSession(entry);

    void audio.play().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : `Unable to play ${entry.word}`);
      setIsPlaying(false);
    });
    void cacheAudio(entry.word, audio.src)
      .then(() => setCached((current) => new Set(current).add(entry.word)))
      .catch(() => {
        // Streaming playback remains available if persistent caching fails.
      });
    preloadFollowing(index);
  }

  function startQueue(queue: VocabularyEntry[], startWord?: string) {
    if (!queue.length) {
      setStatus("No generated audio exists for that selection yet");
      return;
    }
    queueRef.current = queue;
    const start = startWord ? Math.max(0, queue.findIndex((entry) => entry.word === startWord)) : 0;
    playAt(start);
  }

  function togglePause() {
    const audio = audioRef.current;
    if (!audio?.src) return;
    if (!audio.paused) audio.pause();
    else void audio.play().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Unable to resume playback");
    });
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

  function handleEnded() {
    if (repeatRef.current === "word") {
      playAt(indexRef.current);
      return;
    }
    const following = nextIndex(indexRef.current);
    if (following === null) finishQueue();
    else playAt(following);
  }

  function handleAudioError() {
    const audio = audioRef.current;
    if (!audio?.currentSrc) return;
    const error = audio.error;
    setIsPlaying(false);
    setStatus(error?.message ? `Audio error: ${error.message}` : "Unable to load this recording");
  }

  function updateMediaPosition() {
    const audio = audioRef.current;
    if (!("mediaSession" in navigator) || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration)
      });
    } catch {
      // Position reporting is an enhancement and is absent in older Safari versions.
    }
  }

  mediaActionsRef.current = {
    play: () => {
      const audio = audioRef.current;
      if (audio?.paused) void audio.play();
    },
    pause: () => audioRef.current?.pause(),
    previous: () => playAt(indexRef.current - 1),
    next: () => playAt(indexRef.current + 1),
    stop
  };

  return (
    <main>
      <audio
        ref={audioRef}
        class="native-audio"
        preload="auto"
        onPlay={() => {
          setIsPlaying(true);
          setStatus(`Playing ${queueRef.current[indexRef.current]?.word ?? "recording"}`);
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        }}
        onPause={() => {
          setIsPlaying(false);
          if ("mediaSession" in navigator && audioRef.current?.src) {
            navigator.mediaSession.playbackState = "paused";
          }
        }}
        onEnded={handleEnded}
        onError={handleAudioError}
        onTimeUpdate={updateMediaPosition}
        onLoadedMetadata={updateMediaPosition}
        aria-hidden="true"
      />
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
