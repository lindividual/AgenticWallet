import { Fragment, type ReactNode } from 'react';

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let tokenIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;

    if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      result.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      result.push(
        <code key={key} className="rounded bg-base-200 px-1 py-0.5 text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const splitAt = token.indexOf('](');
      const label = token.slice(1, splitAt);
      const href = token.slice(splitAt + 2, -1);
      result.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="link link-primary break-all">
          {label}
        </a>,
      );
    } else {
      result.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
}

export function MarkdownRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      let j = i + 1;
      const codeLines: string[] = [];
      while (j < lines.length && !lines[j].trim().startsWith('```')) {
        codeLines.push(lines[j]);
        j += 1;
      }
      blocks.push(
        <pre key={`code-${i}`} className="overflow-x-auto rounded bg-base-200 p-3 text-xs leading-6">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const headingClass =
        level === 1
          ? 'text-2xl font-bold'
          : level === 2
            ? 'text-xl font-bold'
            : level === 3
              ? 'text-lg font-semibold'
              : 'text-base font-semibold';
      const key = `h-${i}`;
      const contentNodes = renderInlineMarkdown(content, key);
      if (level === 1) {
        blocks.push(
          <h1 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h2>,
        );
      } else if (level === 3) {
        blocks.push(
          <h3 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h3>,
        );
      } else if (level === 4) {
        blocks.push(
          <h4 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h4>,
        );
      } else if (level === 5) {
        blocks.push(
          <h5 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h5>,
        );
      } else {
        blocks.push(
          <h6 key={key} className={`m-0 mt-5 ${headingClass}`}>
            {contentNodes}
          </h6>,
        );
      }
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      let j = i;
      let itemIndex = 0;
      while (j < lines.length && /^\s*[-*+]\s+/.test(lines[j])) {
        const content = lines[j].replace(/^\s*[-*+]\s+/, '');
        items.push(<li key={`ul-${i}-${itemIndex}`}>{renderInlineMarkdown(content, `ul-${i}-${itemIndex}`)}</li>);
        j += 1;
        itemIndex += 1;
      }
      blocks.push(
        <ul key={`ul-${i}`} className="m-0 mt-3 list-disc space-y-1 pl-5 text-base leading-7">
          {items}
        </ul>,
      );
      i = j;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      let j = i;
      let itemIndex = 0;
      while (j < lines.length && /^\s*\d+\.\s+/.test(lines[j])) {
        const content = lines[j].replace(/^\s*\d+\.\s+/, '');
        items.push(<li key={`ol-${i}-${itemIndex}`}>{renderInlineMarkdown(content, `ol-${i}-${itemIndex}`)}</li>);
        j += 1;
        itemIndex += 1;
      }
      blocks.push(
        <ol key={`ol-${i}`} className="m-0 mt-3 list-decimal space-y-1 pl-5 text-base leading-7">
          {items}
        </ol>,
      );
      i = j;
      continue;
    }

    let j = i;
    const paragraphParts: string[] = [];
    while (j < lines.length) {
      const candidate = lines[j];
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) break;
      if (
        /^#{1,6}\s+/.test(candidate) ||
        /^\s*[-*+]\s+/.test(candidate) ||
        /^\s*\d+\.\s+/.test(candidate) ||
        candidateTrimmed.startsWith('```')
      ) {
        break;
      }
      paragraphParts.push(candidateTrimmed);
      j += 1;
    }

    if (paragraphParts.length) {
      const paragraph = paragraphParts.join(' ');
      blocks.push(
        <p key={`p-${i}`} className="m-0 mt-3 text-base leading-7 text-base-content/90">
          {renderInlineMarkdown(paragraph, `p-${i}`)}
        </p>,
      );
      i = j;
      continue;
    }

    i += 1;
  }

  return <Fragment>{blocks}</Fragment>;
}
