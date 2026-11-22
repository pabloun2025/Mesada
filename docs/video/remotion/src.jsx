import React from 'react';
import {
  AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence,
  interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig,
} from 'remotion';
import guiones from './escenas.json';
import tiempos from './tiempos.json';

const blue = '#10294c';
const gold = '#ffc32c';
const url = (name) => staticFile(name);
const names = {presentacion: 'Presentacion', tutorial: 'Tutorial', vertical: 'Vertical'};
const font = '"Atkinson Hyperlegible", "DejaVu Sans", sans-serif';

function Scene({scene, time, kind, index, total, plates}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = kind === 'vertical';
  const clip = Boolean(scene.source);
  const outro = index === total - 1;
  const motion = spring({frame, fps, config: {damping: 20, stiffness: 95}});
  const progress = Math.min(1, (frame + 1) / time.frames);
  const cue = time.cues.find(({start, end}) => frame / fps >= start && frame / fps < end);
  const offset = interpolate(motion, [0, 1], [30, 0]);
  const mediaHeight = vertical ? 1060 : 800;
  const mediaWidth = Math.round(mediaHeight * 540 / 740);
  const showMedia = clip && frame < Math.floor(scene.clip * fps);
  const mediaPosition = vertical ? {left: (1080 - mediaWidth) / 2, top: 495} : {right: 100, top: 98};
  const nav = kind === 'tutorial' && clip ? `CAPÍTULO ${String(index).padStart(2, '0')}` : 'MESADA';
  const hero = vertical ? 'hero-sky-tall.webp' : 'hero-sky-wide.webp';
  const label = {
    fontSize: vertical ? 31 : 26, fontWeight: 700, letterSpacing: '0.15em',
    color: '#214e7b', marginBottom: 22,
  };

  return <AbsoluteFill style={{backgroundColor: '#d8ebfa', color: blue, fontFamily: font}}>
    <Img src={url(`marca/${hero}`)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
    <AbsoluteFill style={{background: clip
      ? 'linear-gradient(120deg, #eef8ff 9%, #ddf0faee 55%, #b7d6f2bc)'
      : 'linear-gradient(110deg, #d8ebfaf5 5%, #eaf6ffef 55%, #c0ddf5aa)'}} />
    <AbsoluteFill style={{
      padding: vertical ? '105px 86px 245px' : '74px 100px 158px',
      display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: vertical ? 'flex-start' : 'center',
      justifyContent: vertical ? (clip ? 'flex-start' : 'center') : 'space-between', gap: vertical ? 48 : 78,
    }}>
      <section style={{position: 'relative', width: clip && !vertical ? '51%' : '100%',
        transform: `translateY(${offset}px)`, opacity: Math.min(1, frame / 8 + 0.15)}}>
        {!clip && <Img src={url('marca/logo.png')} style={{width: vertical ? 320 : 255,
          marginBottom: 44, transform: `scale(${0.93 + 0.07 * motion})`, transformOrigin: 'left bottom'}} />}
        <div style={label}>{nav}</div>
        <div style={{width: 104, height: 9, borderRadius: 9, background: gold, marginBottom: 31}} />
        <h1 style={{fontSize: vertical ? 83 : clip ? 88 : 116, maxWidth: clip ? 900 : 1270,
          lineHeight: 1.03, letterSpacing: '-0.045em', margin: '0 0 30px', fontWeight: 800}}>
          {scene.title}
        </h1>
        <div style={{display: 'inline-block', maxWidth: '100%', fontSize: vertical ? 39 : 38,
          lineHeight: 1.28, fontWeight: 700, border: outro ? 'none' : '2px solid #a8c5de',
          borderRadius: 24, background: outro ? blue : '#f9fdff', color: outro ? 'white' : blue,
          padding: '15px 24px'}}>
          {scene.guide}
        </div>
      </section>
      {clip && <div style={{width: mediaWidth, height: mediaHeight, alignSelf: 'center', flexShrink: 0,
        background: '#edf6ff', border: `8px solid ${blue}`, borderRadius: 31, overflow: 'hidden',
        position: 'absolute', ...mediaPosition, boxShadow: '0 23px 65px #10294c45'}}>
        {!plates && (showMedia ? <OffthreadVideo muted src={url(`grabaciones/${kind}-${index}.mp4`)}
          style={{width: '100%', height: '100%', objectFit: 'cover'}} />
          : <Img src={url(`grabaciones/${kind}-${index}.jpg`)} style={{width: '100%', height: '100%',
            objectFit: 'cover'}} />)}
      </div>}
    </AbsoluteFill>
    {cue && <div style={{position: 'absolute', bottom: vertical ? 228 : 52, left: vertical ? 78 : 190,
      right: vertical ? 78 : 190, textAlign: 'center'}}>
      <div style={{display: 'inline-block', background: '#0a1d35f2', color: 'white', borderRadius: 17,
        padding: '12px 26px', fontSize: vertical ? 42 : 39, lineHeight: 1.18,
        fontWeight: 700, whiteSpace: 'pre-line'}}>{cue.text}</div>
    </div>}
    {!plates && <div style={{position: 'absolute', left: vertical ? 90 : 100, right: vertical ? 90 : 100,
      bottom: vertical ? 174 : 25, height: 5, borderRadius: 8, background: '#44699344'}}>
      <div style={{width: `${100 * (index + progress) / total}%`, height: '100%', borderRadius: 8, background: '#145083'}} />
    </div>}
    {!plates && <Audio src={url(`voz/${kind}-${index}.m4a`)} />}
  </AbsoluteFill>;
}

function Film({kind, plates = false}) {
  let start = 0;
  return guiones[kind].map((scene, index) => {
    const time = tiempos[kind][index];
    const from = start;
    start += time.frames;
    return <Sequence key={scene.title} name={scene.title} from={from} durationInFrames={time.frames}>
      <Scene scene={scene} time={time} kind={kind} index={index} total={guiones[kind].length} plates={plates} />
    </Sequence>;
  });
}

function Root() {
  return Object.keys(tiempos).map((kind) => (
    <Composition key={kind} id={names[kind]} component={Film} defaultProps={{kind}} fps={30}
      width={kind === 'vertical' ? 1080 : 1920} height={kind === 'vertical' ? 1920 : 1080}
      durationInFrames={tiempos[kind].reduce((sum, scene) => sum + scene.frames, 0)} />
  ));
}

registerRoot(Root);
