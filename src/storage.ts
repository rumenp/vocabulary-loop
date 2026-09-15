import { createStore, get, set } from "idb-keyval";
import type { AudioManifest, Preferences } from "./types";

const settingsStore = createStore("vocabulary-loop-settings", "keyval");
const preferencesKey = "preferences";
const audioCacheName = "vocabulary-loop-audio-v1";

export const defaultPreferences: Preferences = {
  selected: [],
  repeat: "queue",
  rate: 1
};

export async function loadPreferences(): Promise<Preferences> {
  return (await get<Preferences>(preferencesKey, settingsStore)) ?? defaultPreferences;
}

export async function savePreferences(preferences: Preferences): Promise<void> {
  await set(preferencesKey, preferences, settingsStore);
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function getCachedWords(manifest: AudioManifest): Promise<Set<string>> {
  const cache = await caches.open(audioCacheName);
  const requests = await cache.keys();
  const wordsByFilename = new Map(Object.entries(manifest).map(([word, filename]) => [filename, word]));
  return new Set(
    requests
      .map((request) => decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? ""))
      .map((filename) => wordsByFilename.get(filename))
      .filter((word): word is string => Boolean(word))
  );
}

export async function cacheAudio(word: string, url: string): Promise<void> {
  const cache = await caches.open(audioCacheName);
  const request = new Request(url);
  if (await cache.match(request)) return;
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Audio unavailable for ${word} (${response.status})`);
  await cache.put(request, response);
}

export async function clearCachedAudio(): Promise<void> {
  await caches.delete(audioCacheName);
}
