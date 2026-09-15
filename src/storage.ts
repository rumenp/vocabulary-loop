import { clear, createStore, get, keys, set } from "idb-keyval";
import type { Preferences } from "./types";

const settingsStore = createStore("vocabulary-loop-settings", "keyval");
const audioStore = createStore("vocabulary-loop-audio", "keyval");
const preferencesKey = "preferences";

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

export async function getCachedWords(): Promise<Set<string>> {
  return new Set((await keys<string>(audioStore)).map((key) => String(key)));
}

export async function cacheAudio(word: string, url: string): Promise<Blob> {
  const existing = await get<Blob>(word, audioStore);
  if (existing) return existing;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Audio unavailable for ${word} (${response.status})`);
  const blob = await response.blob();
  await set(word, blob, audioStore);
  return blob;
}

export async function audioObjectUrl(word: string, url: string): Promise<string> {
  const blob = await cacheAudio(word, url);
  return URL.createObjectURL(blob);
}

export async function clearCachedAudio(): Promise<void> {
  await clear(audioStore);
}
