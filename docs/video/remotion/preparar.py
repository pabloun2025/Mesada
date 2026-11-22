"""Genera las pistas, la duración por escena y los SRT a partir del guion."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

import numpy as np
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "public"
FPS = 30
LEAD = 0.52
NAMES = {
    "presentacion": "presentacion-v2",
    "tutorial": "tutorial-v2",
    "vertical": "presentacion-vertical-v2",
}
MINIMUM = {"presentacion": 7.7, "tutorial": 0, "vertical": 4.35}


def ffmpeg(*args):
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
        check=True,
    )


def captions(text):
    """Agrupa palabras en intervenciones cortas sin cortar palabras."""
    pending = []
    for word in text.split():
        if pending and len(" ".join([*pending, word])) > 76:
            yield " ".join(pending)
            pending = []
        pending.append(word)
        if word.endswith((".", "?", "!")) and len(" ".join(pending)) > 29:
            yield " ".join(pending)
            pending = []
    if pending:
        yield " ".join(pending)


def stamp(seconds):
    total = round(seconds * 1000)
    return f"{total // 3600000:02}:{total // 60000 % 60:02}:{total // 1000 % 60:02},{total % 1000:03}"


def wrap(text):
    words = text.split()
    if len(text) <= 43:
        return text
    cut = min(range(1, len(words)), key=lambda i: abs(len(" ".join(words[:i])) - len(text) / 2))
    return " ".join(words[:cut]) + "\n" + " ".join(words[cut:])


def write_scene(kokoro, cfg, scene, key, index):
    chunks = []
    cues = []
    elapsed = LEAD
    for text in captions(scene["voice"]):
        samples, rate = kokoro.create(
            text, voice=cfg["voice"], speed=cfg["speed"], lang=cfg["language"]
        )
        if not chunks:
            chunks.append(np.zeros(round(rate * LEAD), dtype=np.float32))
        end = elapsed + len(samples) / rate
        cues.append({"start": elapsed, "end": end, "text": wrap(text)})
        pause = round(rate * cfg["pause"])
        chunks.extend([samples, np.zeros(pause, dtype=np.float32)])
        elapsed = end + pause / rate
    audio = OUTPUT / "voz" / f"{key}-{index}.m4a"
    with tempfile.TemporaryDirectory() as temp:
        raw = Path(temp) / "voz.wav"
        with wave.open(str(raw), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes((np.concatenate(chunks).clip(-1, 1) * 32767).astype("<i2").tobytes())
        ffmpeg("-i", raw, "-af", f"loudnorm=I=-16:TP=-1.5:LRA=6,volume={cfg['volumeDb']}dB",
               "-ar", "48000", "-c:a", "aac", "-b:a", "128k", audio)
    if scene["source"]:
        original_dir = Path(os.environ.get("MESADA_GRABACIONES", HERE.parent))
        original = original_dir / f"{scene['source']}.mp4"
        clip = OUTPUT / "grabaciones" / f"{key}-{index}.mp4"
        ffmpeg("-ss", scene["start"], "-i", original, "-t", scene["clip"], "-an",
               "-vf", "crop=1080:1480:0:420,scale=540:740", "-c:v", "libx264",
               "-threads", "2", "-preset", "fast", "-crf", "20", "-movflags", "+faststart", clip)
        ffmpeg("-ss", max(0, scene["clip"] - 0.14), "-i", clip, "-frames:v", "1",
               "-update", "1", clip.with_suffix(".jpg"))
    return {"frames": math.ceil(max(MINIMUM[key], elapsed + 0.45, scene["clip"] + LEAD + 0.5) * FPS),
            "cues": cues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", choices=NAMES)
    parser.add_argument("--escena", type=int, help="Número de escena, empezando por uno")
    args = parser.parse_args()
    scenes = json.loads((HERE / "escenas.json").read_text())
    if args.escena is not None and (not args.video or not 1 <= args.escena <= len(scenes[args.video])):
        parser.error("--escena requiere --video y un número de escena válido")
    for directory in ("voz", "grabaciones", "marca"):
        (OUTPUT / directory).mkdir(parents=True, exist_ok=True)
    brand = HERE.parents[2] / "web" / "public" / "brand"
    for file in ("logo.png", "hero-sky-wide.webp", "hero-sky-tall.webp"):
        shutil.copyfile(brand / file, OUTPUT / "marca" / file)

    timing = HERE / "tiempos.json"
    timings = json.loads(timing.read_text()) if timing.exists() else {}
    if args.escena and args.video not in timings:
        parser.error("Genera primero el vídeo completo para disponer de sus tiempos")
    model = Path(os.environ.get("MESADA_MODELOS", HERE / "modelos"))
    kokoro = Kokoro(str(model / "kokoro-v1.0.onnx"), str(model / "voices-v1.0.bin"))
    cfg = json.loads((HERE / "voz.json").read_text())
    for key in ([args.video] if args.video else NAMES):
        if not args.escena:
            timings[key] = [None] * len(scenes[key])
        offset = 0
        subtitle = []
        for index, scene in enumerate(scenes[key]):
            if not args.escena or args.escena == index + 1:
                print(f"{key} · {index + 1} · {scene['title']}", flush=True)
                timings[key][index] = write_scene(kokoro, cfg, scene, key, index)
            timing_entry = timings[key][index]
            for cue in timing_entry["cues"]:
                subtitle.append(f"{len(subtitle) + 1}\n"
                                f"{stamp(offset + cue['start'])} --> {stamp(offset + cue['end'])}\n"
                                f"{cue['text']}\n")
            offset += timing_entry["frames"] / FPS
        folder = HERE.parent / "subtitulos"
        folder.mkdir(exist_ok=True)
        (folder / f"{NAMES[key]}.srt").write_text("\n".join(subtitle) + "\n")
        print(f"{key}: {offset:.2f} s", flush=True)
    timing.write_text(json.dumps(timings, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
