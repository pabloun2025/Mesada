import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Texto en línea: **negrita**, _cursiva_, `código` y [enlace](destino). Las rutas que empiezan por «/» usan el router. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={k} className="rounded bg-[var(--chip)] px-1 py-0.5 text-[0.9em]">{m[3]}</code>);
    else {
      const href = m[5];
      const cls = 'font-bold text-tangerine-deep underline underline-offset-2';
      out.push(href.startsWith('/') ? <Link key={k} to={href} className={cls}>{m[4]}</Link> : <a key={k} href={href} className={cls} {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{m[4]}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Subconjunto de Markdown de docs/legal: # ## ###, párrafos, listas con «- », cursiva de línea completa. */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`} className="mb-4 leading-relaxed">{inline(para.join(' '), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length) {
      const id = blocks.length;
      blocks.push(<ul key={`l${id}`} className="mb-4 list-disc space-y-2 pl-6 leading-relaxed marker:text-[var(--fg-3)]">{list.map((t, j) => <li key={j}>{inline(t, `l${id}-${j}`)}</li>)}</ul>);
    }
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const id = blocks.length;
      if (h[1] === '#') blocks.push(<h1 key={`h${id}`} className="mb-2 text-3xl font-extrabold">{inline(h[2], `h${id}`)}</h1>);
      else if (h[1] === '##') blocks.push(<h2 key={`h${id}`} className="mt-8 mb-3 text-xl font-extrabold">{inline(h[2], `h${id}`)}</h2>);
      else blocks.push(<h3 key={`h${id}`} className="mt-5 mb-2 text-lg font-bold">{inline(h[2], `h${id}`)}</h3>);
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^[-*]\s+/, ''));
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list.length && /^\s+\S/.test(raw)) {
      list[list.length - 1] += ` ${line.trim()}`; // continuación de un elemento de lista
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return <Fragment>{blocks}</Fragment>;
}
