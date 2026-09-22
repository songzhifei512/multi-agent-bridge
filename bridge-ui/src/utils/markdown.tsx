/**
 * 轻量 Markdown 渲染器
 * 支持: 标题(# ## ###)、加粗(**)、行内代码(`)、代码块(```)、
 *       无序列表(-/*)、有序列表(1.)、引用(>)、段落、换行、链接
 * 设计目标: 零依赖、安全(无 HTML 注入)、适配侧边栏窄宽度
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  let s = escapeHtml(text);
  // 行内代码
  s = s.replace(/\`([^\`]+)\`/g, '<code class="md-code">$1</code>');
  // 加粗
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

interface Block {
  type: 'heading' | 'paragraph' | 'code' | 'ul' | 'ol' | 'quote' | 'hr' | 'table';
  content: string;
  level?: number;
  lang?: string;
  items?: string[];
  headers?: string[];
  rows?: string[][];
}

function parseBlocks(md: string): Block[] {
  // 规范化行尾：\r\n -> \n，然后按行分割并修剪每行尾部空白
  const lines = md.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (trimmed === '') { i++; continue; }

    // 分割线
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: 'hr', content: '' });
      i++; continue;
    }

    // 代码块
    if (/^\`\`\`/.test(trimmed)) {
      const lang = trimmed.replace(/^\`\`\`/, '').trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\`\`\`/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', content: codeLines.join('\n'), lang });
      continue;
    }

    // 标题
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      blocks.push({ type: 'heading', content: hMatch[2], level: hMatch[1].length });
      i++; continue;
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', content: quoteLines.join(' ') });
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', content: '', items });
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', content: '', items });
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && i + 1 < lines.length) {
      const sepLine = lines[i + 1].trim();
      // 分隔行只含 |、-、:、空格，且至少有一个 |（兼容 |---| 和 ---|---| 两种格式）
      if (sepLine.includes('|') && /^[\|\s\-:]+$/.test(sepLine)) {
        // 解析表头：去掉开头的 |，如果结尾有 | 也去掉，然后分割
        let headerStr = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
        if (headerStr.endsWith('|')) headerStr = headerStr.slice(0, -1);
        const headers = headerStr.split('|').map(c => c.trim());
        i += 2; // 跳过表头行和分隔行
        // 解析数据行（不强制要求结尾为 |）
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          let rowStr = lines[i].trim().slice(1);
          if (rowStr.endsWith('|')) rowStr = rowStr.slice(0, -1);
          const row = rowStr.split('|').map(c => c.trim());
          rows.push(row);
          i++;
        }
        blocks.push({ type: 'table', content: '', headers, rows });
        continue;
      }
    }

    // 段落（连续非空行）
    // 注意：不单独检查 | 行，因为表格检测在段落检测之前，
    // 如果表格检测失败，那些行应该作为普通段落内容处理
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^#{1,4}\s+/.test(lines[i].trim()) &&
           !/^\`\`\`/.test(lines[i].trim()) &&
           !/^[-*]\s+/.test(lines[i].trim()) &&
           !/^\d+\.\s+/.test(lines[i].trim()) &&
           !lines[i].trim().startsWith('>') &&
           !/^---+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', content: paraLines.join(' ') });
  }

  return blocks;
}

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const blocks = parseBlocks(md);
  const parts: string[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        parts.push(`<h${b.level} class="md-h${b.level}">${renderInline(b.content)}</h${b.level}>`);
        break;
      case 'paragraph':
        parts.push(`<p class="md-p">${renderInline(b.content)}</p>`);
        break;
      case 'code':
        parts.push(`<pre class="md-pre"><code class="md-code">${escapeHtml(b.content)}</code></pre>`);
        break;
      case 'ul':
        parts.push(`<ul class="md-ul">${(b.items || []).map(it => `<li class="md-li">${renderInline(it)}</li>`).join('')}</ul>`);
        break;
      case 'ol':
        parts.push(`<ol class="md-ol">${(b.items || []).map(it => `<li class="md-li">${renderInline(it)}</li>`).join('')}</ol>`);
        break;
      case 'quote':
        parts.push(`<blockquote class="md-quote">${renderInline(b.content)}</blockquote>`);
        break;
      case 'hr':
        parts.push('<hr class="md-hr" />');
        break;
      case 'table':
        const thead = (b.headers || []).map(h => `<th class="md-th">${renderInline(h)}</th>`).join('');
        const tbody = (b.rows || []).map(row =>
          `<tr class="md-tr">${row.map(cell => `<td class="md-td">${renderInline(cell)}</td>`).join('')}</tr>`
        ).join('');
        parts.push(`<table class="md-table"><thead class="md-thead"><tr class="md-tr">${thead}</tr></thead><tbody class="md-tbody">${tbody}</tbody></table>`);
        break;
    }
  }

  return parts.join('');
}

/** React 组件：安全地渲染 Markdown 结果（在 .tsx 中使用时直接调用 renderMarkdown + dangerouslySetInnerHTML） */
