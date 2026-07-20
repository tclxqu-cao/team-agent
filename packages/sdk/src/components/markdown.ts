function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function renderMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  const withoutCodeBlocks = text.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const index = codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`) - 1;
    return `\n@@CODE_BLOCK_${index}@@\n`;
  });

  return withoutCodeBlocks
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const codeBlock = block.match(/^@@CODE_BLOCK_(\d+)@@$/);
      if (codeBlock) return codeBlocks[Number(codeBlock[1])];

      const lines = block.split('\n');
      if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
        return `<ul>${lines
          .map((line) => `<li>${renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }

      return `<p>${lines.map(renderInlineMarkdown).join('<br>')}</p>`;
    })
    .join('');
}
