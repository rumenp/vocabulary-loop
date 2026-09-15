#!/usr/bin/env python3
"""Generate the Athena vocabulary corpus without persisting the API key."""

from __future__ import annotations

import argparse
import concurrent.futures
import http.client
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LESSONS_PATH = ROOT / "content" / "word-lessons.json"
VOCABULARY_PATH = ROOT / "public" / "vocabulary.json"
OUTPUT_DIR = ROOT / "public" / "audio"
MANIFEST_PATH = ROOT / "public" / "audio-manifest.json"

MODEL = "aura-2-athena-en"
SPEED = 0.9
BIT_RATE = 48_000
MAX_ATTEMPTS = 6
MINIMUM_BYTES = 1_000


def filename_for(word: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", word.lower()).strip("-") + ".mp3"


def valid_audio(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < MINIMUM_BYTES:
        return False
    prefix = path.read_bytes()[:3]
    return prefix == b"ID3" or prefix[:1] == b"\xff"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("/", " or ").replace("&", "and")).strip()


def narration(lesson: dict[str, str], gloss: str) -> str:
    word = lesson["word"]
    spoken_word = word[:1].upper() + word[1:]
    return (
        f"{spoken_word}. {spoken_word} means {normalize(gloss)}. "
        f"Memory trick: {lesson['memory']} "
        f"For example: {lesson['example']} {spoken_word}."
    )


def request_audio(api_key: str, text: str) -> bytes:
    query = urllib.parse.urlencode(
        {
            "model": MODEL,
            "encoding": "mp3",
            "bit_rate": BIT_RATE,
            "speed": SPEED,
        }
    )
    request = urllib.request.Request(
        f"https://api.deepgram.com/v1/speak?{query}",
        data=json.dumps({"text": text}).encode(),
        method="POST",
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        audio = response.read()
        if response.headers.get_content_type() != "audio/mpeg" or len(audio) < MINIMUM_BYTES:
            raise RuntimeError(
                f"unexpected response: {response.headers.get_content_type()}, {len(audio)} bytes"
            )
        return audio


def generate_one(api_key: str, item: dict[str, str]) -> int:
    destination = OUTPUT_DIR / item["filename"]
    if valid_audio(destination):
        return destination.stat().st_size

    for attempt in range(MAX_ATTEMPTS):
        try:
            audio = request_audio(api_key, item["narration"])
            temporary = destination.with_suffix(".mp3.part")
            temporary.write_bytes(audio)
            temporary.replace(destination)
            return len(audio)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code != 429 and not 500 <= error.code < 600:
                raise RuntimeError(f"HTTP {error.code}: {detail}") from error
            if attempt + 1 == MAX_ATTEMPTS:
                raise RuntimeError(f"HTTP {error.code}: {detail}") from error
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else 2**attempt
        except (OSError, TimeoutError, urllib.error.URLError, http.client.IncompleteRead) as error:
            if attempt + 1 == MAX_ATTEMPTS:
                raise RuntimeError(str(error)) from error
            delay = 2**attempt
        time.sleep(min(delay + random.random(), 60))
    raise AssertionError("retry loop exhausted")


def write_manifest(items: list[dict[str, str]]) -> int:
    manifest = {
        item["word"]: item["filename"]
        for item in items
        if valid_audio(OUTPUT_DIR / item["filename"])
    }
    temporary = MANIFEST_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(MANIFEST_PATH)
    return len(manifest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    lessons = json.loads(LESSONS_PATH.read_text())
    vocabulary = json.loads(VOCABULARY_PATH.read_text())
    if [item["word"] for item in lessons] != [item["word"] for item in vocabulary]:
        raise RuntimeError("lesson order does not match vocabulary order")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    items = [
        {
            "word": lesson["word"],
            "filename": filename_for(lesson["word"]),
            "narration": narration(lesson, word["gloss"]),
        }
        for lesson, word in zip(lessons, vocabulary, strict=True)
    ]
    filenames = [item["filename"] for item in items]
    if len(filenames) != len(set(filenames)):
        raise RuntimeError("audio filename collision")

    complete = [item for item in items if valid_audio(OUTPUT_DIR / item["filename"])]
    pending = [item for item in items if not valid_audio(OUTPUT_DIR / item["filename"])]
    if args.limit is not None:
        pending = pending[: args.limit]
    characters = sum(len(item["narration"]) for item in items)
    print(f"Corpus: {len(complete):,}/{len(items):,} recordings already complete")
    print(f"Narration characters: {characters:,}")
    print(f"Estimated cost before credits at $0.03/1K chars: ${characters * 0.00003:,.2f}")
    print(f"Queued this run: {len(pending):,}")
    if args.dry_run:
        return 0

    api_key = os.environ.get("DEEPGRAM_TEST_KEY")
    if not api_key:
        print("Set DEEPGRAM_TEST_KEY in the environment.", file=sys.stderr)
        return 2

    failures: list[str] = []
    generated = 0
    byte_count = 0
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(generate_one, api_key, item): item for item in pending}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                byte_count += future.result()
                generated += 1
                if generated == 1 or generated % 10 == 0:
                    rate = generated / (time.monotonic() - started) * 60
                    print(f"Generated {generated:,}/{len(pending):,} ({rate:.1f}/min)", flush=True)
            except Exception as error:
                message = f"{item['word']}: {error}"
                failures.append(message)
                print(f"FAILED {message}", file=sys.stderr, flush=True)

    manifest_count = write_manifest(items)
    print(f"Manifest: {manifest_count:,}/{len(items):,}")
    print(f"Generated this run: {byte_count / 1_000_000:.1f} MB")
    if failures:
        print(f"Failures: {len(failures):,}; rerun to retry", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
