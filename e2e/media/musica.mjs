// Genera la música de fondo (acordes sinusoidales suaves) con ffmpeg. Nada descargado.
// Uso: node media/musica.mjs [segundos] [salida.m4a]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { OUT_DIR } from './video-lib.mjs';

const secs = Number(process.argv[2] || 140);
const out = process.argv[3] || path.join(OUT_DIR, 'fondo.m4a');
const STEP = 5.5, LEN = 8;
// Do mayor 7 · La menor 7 · Fa mayor 7 · Sol 6 (notas en Hz)
const CHORDS = [[130.81, 164.81, 196.0, 246.94, 329.63], [110.0, 164.81, 196.0, 261.63, 329.63], [87.31, 174.61, 220.0, 261.63, 329.63], [98.0, 196.0, 246.94, 293.66, 329.63]];
const files = CHORDS.map((notes, i) => {
  const f = path.join(OUT_DIR, `acorde${i}.wav`);
  const ins = notes.flatMap((n) => ['-f', 'lavfi', '-i', `sine=frequency=${n}:sample_rate=44100:duration=${LEN}`]);
  const mix = notes.map((_, k) => `[${k}]`).join('') + `amix=inputs=${notes.length}:normalize=1,tremolo=f=0.18:d=0.35,lowpass=f=1400,afade=t=in:st=0:d=2.6,afade=t=out:st=${LEN - 2.6}:d=2.6,volume=2.2`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...ins, '-filter_complex', mix, '-ac', '2', f]);
  return f;
});
const n = Math.ceil(secs / STEP);
const ins = [], parts = [];
for (let i = 0; i < n; i++) { ins.push('-i', files[i % 4]); parts.push(`[${i}]adelay=${Math.round(i * STEP * 1000)}|${Math.round(i * STEP * 1000)}[c${i}]`); }
const graph = parts.join(';') + ';' + parts.map((_, i) => `[c${i}]`).join('') + `amix=inputs=${n}:normalize=0:dropout_transition=0,aecho=0.8:0.6:420:0.25,volume=2.0,atrim=0:${secs}[o]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...ins, '-filter_complex', graph, '-map', '[o]', '-c:a', 'aac', '-b:a', '128k', out]);
console.log('música', out, fs.statSync(out).size, 'bytes');
