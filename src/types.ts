export interface VocabularyEntry {
  word: string;
  theme: string;
  frame: string;
  side: string;
  cluster: string;
  sense: string;
  gloss: string;
  pos: string;
  wordsense?: string;
}

export type AudioManifest = Record<string, string>;
export type RepeatMode = "off" | "queue" | "word";

export interface Preferences {
  selected: string[];
  repeat: RepeatMode;
  rate: number;
}

