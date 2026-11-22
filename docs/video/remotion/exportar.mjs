/**
 * Remotion dibuja el montaje y los subtítulos. FFmpeg conserva todos los
 * fotogramas de las grabaciones entre los cambios del diseño.
 */
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {openBrowser, renderFrames, selectComposition} from '@remotion/renderer';

const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const names = {
  presentacion: ['Presentacion', 'presentacion-v2'],
  tutorial: ['Tutorial', 'tutorial-v2'],
  vertical: ['Vertical', 'presentacion-vertical-v2'],
};
const requested = process.argv[2];
if (requested && !Object.hasOwn(names, requested)) throw new Error(`Vídeo desconocido: ${requested}`);
const films = requested ? [requested] : Object.keys(names);
const guiones = readJson('./escenas.json');
const timings = readJson('./tiempos.json');
const fps = 30;
const pad = (number) => String(number).padStart(7, '0');

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFmpeg terminó con estado ${result.status}`);
}

function layout(kind) {
  const height = kind === 'vertical' ? 1060 : 800;
  const width = Math.round(height * 540 / 740);
  const x = kind === 'vertical' ? Math.floor((1080 - width) / 2) : 1920 - 100 - width;
  const y = kind === 'vertical' ? 495 : 98;
  return {width: width - 16, height: height - 16, x: x + 8, y: y + 8};
}

function keyframes(scene) {
  const changes = scene.cues.flatMap(({start, end}) => [
    Math.ceil(start * fps - 1e-8), Math.ceil(end * fps - 1e-8),
  ]);
  return [...new Set([0, 3, 6, 9, 12, 16, 21, ...changes])]
    .filter((frame) => frame < scene.frames).sort((a, b) => a - b);
}

function encodeScene(folder, kind, scene, index) {
  const list = path.join(folder, `scene-${index}.ffconcat`);
  const plates = scene.keys.map((frame, n) => {
    const next = scene.keys[n + 1] ?? scene.frames;
    return `file ${pad(scene.from + frame)}.jpg\noption framerate 30\nduration ${((next - frame) / fps).toFixed(9)}`;
  });
  plates.push(`file ${pad(scene.from + scene.keys.at(-1))}.jpg\noption framerate 30`);
  writeFileSync(list, `ffconcat version 1.0\n${plates.join('\n')}\n`);
  const audio = path.resolve('public/voz', `${kind}-${index}.m4a`);
  const plateInput = ['-f', 'concat', '-safe', '0', '-i', list, '-i', audio];
  const video = path.resolve('public/grabaciones', `${kind}-${index}.mp4`);
  const result = path.join(folder, `scene-${index}.mkv`);

  let filters = '[0:v]fps=30,format=yuv420p[base]';
  let output = '[base]';
  if (guiones[kind][index].source) {
    const {width, height, x, y} = layout(kind);
    plateInput.push('-i', video);
    const cornerX = 'max(0,22-min(X,W-1-X))';
    const cornerY = 'max(0,22-min(Y,H-1-Y))';
    const mask = `if(lte(hypot(${cornerX},${cornerY}),22),255,0)`;
    filters += `;[2:v]fps=30,scale=${width}:${height}:flags=lanczos,setsar=1,format=yuva444p,`
      + `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${mask}'[app];`
      + `[base][app]overlay=x=${x}:y=${y}:eof_action=repeat[scene]`;
    output = '[scene]';
  }
  const duration = (scene.frames / fps).toFixed(9);
  ffmpeg([
    ...plateInput, '-filter_complex_threads', '2', '-filter_complex', filters, '-map', output,
    '-map', '1:a:0', '-af', `apad,atrim=duration=${duration}`,
    '-t', duration, '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000', result,
  ]);
  return path.basename(result);
}

const browserExecutable = process.env.MESADA_CHROMIUM || undefined;
const browser = await openBrowser('chrome', {browserExecutable});
const scratch = mkdtempSync(path.join(tmpdir(), 'mesada-export-'));
try {
  const serveUrl = await bundle({entryPoint: path.resolve('src.jsx'), onProgress: () => {}});
  for (const kind of films) {
    const [id, slug] = names[kind];
    const inputProps = {kind, plates: true};
    const composition = await selectComposition({serveUrl, id, inputProps, puppeteerInstance: browser});
    let from = 0;
    const scenes = timings[kind].map((time) => {
      const result = {...time, from, keys: keyframes(time)};
      from += time.frames;
      return result;
    });
    const frames = scenes.flatMap((scene) => scene.keys.map((n) => scene.from + n));
    console.log(`${id} · ${frames.length} fotogramas de rótulos y composición`);
    await renderFrames({
      composition, serveUrl, inputProps, puppeteerInstance: browser, outputDir: null, frames,
      concurrency: 2, imageFormat: 'jpeg', jpegQuality: 93, onStart: () => {}, onFrameUpdate: () => {},
      onFrameBuffer: (buffer, frame) => writeFileSync(path.join(scratch, `${pad(frame)}.jpg`), buffer),
    });
    const segments = scenes.map((scene, index) => {
      console.log(`${id} · escena ${index + 1}/${scenes.length}`);
      return encodeScene(scratch, kind, scene, index);
    });
    const playlist = path.join(scratch, 'final.ffconcat');
    writeFileSync(playlist, `ffconcat version 1.0\n${segments.map((file) => `file ${file}`).join('\n')}\n`);
    const output = path.resolve('..', `${slug}.mp4`);
    const temporary = path.join(path.dirname(output), `.${slug}.render.mp4`);
    try {
      ffmpeg(['-f', 'concat', '-safe', '0', '-i', playlist, '-map', '0:v', '-map', '0:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', temporary]);
      renameSync(temporary, output);
    } finally {
      rmSync(temporary, {force: true});
    }
    console.log(output);
  }
} finally {
  await browser.close({silent: true});
  rmSync(scratch, {recursive: true, force: true});
}
