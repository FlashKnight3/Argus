/**
 * Minimal, safe markdown for agent output: headings, paragraphs, bullet/numbered lists, tables,
 * **bold**, and `code`. Builds React elements only (never HTML strings), so model text cannot
 * inject markup.
 */
import type { ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**') ? <strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong> : <code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const key = `b${k++}`;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { blocks.push(<h4 key={key}>{inline(heading[2], key)}</h4>); i++; continue; }
    if (line.trim().startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      const body = rows.filter(r => !isDivider(r));
      const [head, ...rest] = body;
      blocks.push(<div className="md-table" key={key}><table><thead><tr>{cells(head).map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
        <tbody>{rest.map((r, ri) => <tr key={ri}>{cells(r).map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      const children = items.map((it, j) => <li key={j}>{inline(it, `${key}l${j}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>);
  }
  return <div className="md">{blocks}</div>;
}

/** First sentence or two of model output with markdown removed, for compact previews. */
export function plainPreview(text: string, max = 180): string {
  const firstPara = text.replace(/\r/g, '').split(/\n\s*\n/)[0] ?? '';
  const plain = firstPara.replace(/\*\*|`|^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain;
}
