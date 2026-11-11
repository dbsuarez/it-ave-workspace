// Builds a Word (.docx) document from the canvas editor's JSON (ProseMirror document) and the pictures it
// uses. Runs in the main process (Node); the renderer only sends data. Pure and covered by tests.
//
// Supported: headings, paragraphs with bold / italic / strike / code / links, bulleted, numbered and
// checklist lists (nested), quotes, code blocks, dividers, tables (header row, alignment, column widths),
// callouts, pictures (size and alignment) and @mentions.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun,
  ExternalHyperlink, AlignmentType, LevelFormat, ShadingType, BorderStyle,
} = require('docx');

const PAGE_WIDTH_PX = 600; // usable width of an A4 page with 1 inch margins at 96 dpi
const TWIPS_PER_PX = 15;
const MAX_TABLE_TWIPS = 9000;
const CALLOUT_COLORS = {
  info: { fill: 'E8F0FE', bar: '3B82F6' },
  note: { fill: 'F3F4F6', bar: '6B7280' },
  tip: { fill: 'E7F7EC', bar: '22C55E' },
  warning: { fill: 'FEF6DD', bar: 'EAB308' },
  danger: { fill: 'FDE8E8', bar: 'EF4444' },
};
const HEADINGS = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const GRID_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };

function plainText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return `@${node.attrs?.username || ''}`;
  return (node.content || []).map(plainText).join('');
}

// ---- inline content ------------------------------------------------------------------------

function runFor(node, extra = {}) {
  const marks = new Set((node.marks || []).map((mark) => mark.type));
  return new TextRun({
    text: node.text || '',
    bold: marks.has('bold') || extra.bold,
    italics: marks.has('italic') || extra.italics,
    strike: marks.has('strike'),
    font: marks.has('code') ? 'Consolas' : undefined,
    shading: marks.has('code') ? { type: ShadingType.CLEAR, fill: 'F3F4F6' } : undefined,
    color: extra.color,
    size: extra.size,
  });
}

function inlineRuns(nodes = [], extra = {}) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const link = (node.marks || []).find((mark) => mark.type === 'link');
      if (link && /^(https?:|mailto:)/i.test(link.attrs?.href || '')) {
        out.push(new ExternalHyperlink({ link: link.attrs.href, children: [new TextRun({ text: node.text || '', style: 'Hyperlink', bold: extra.bold })] }));
      } else {
        out.push(runFor(node, extra));
      }
    } else if (node.type === 'hardBreak') {
      out.push(new TextRun({ break: 1 }));
    } else if (node.type === 'mention') {
      out.push(new TextRun({ text: `@${node.attrs?.username || ''}`, bold: true, color: '6D28D9' }));
    } else if (node.content) {
      out.push(...inlineRuns(node.content, extra));
    }
  }
  return out;
}

// ---- blocks --------------------------------------------------------------------------------

function paragraph(node, options = {}) {
  return new Paragraph({
    children: inlineRuns(node.content, options.run),
    spacing: { after: options.after ?? 120 },
    alignment: options.alignment,
    indent: options.indent,
    numbering: options.numbering,
    border: options.border,
    shading: options.shading,
    keepNext: options.keepNext,
  });
}

function imageParagraph(node, ctx) {
  const match = /^file:(\d+)$/.exec(node.attrs?.src || '');
  const picture = match && ctx.images && ctx.images[match[1]];
  const alt = node.attrs?.alt || 'picture';
  if (!picture || !picture.data || !picture.width || !picture.height) {
    return new Paragraph({ children: [new TextRun({ text: `[${alt}]`, italics: true, color: '6B7280' })], spacing: { after: 120 } });
  }
  const percent = node.attrs?.width ? Math.min(100, Math.max(10, Number(node.attrs.width))) : null;
  const maxWidth = Math.round(PAGE_WIDTH_PX * ((percent || 100) / 100));
  const width = percent ? maxWidth : Math.min(picture.width, maxWidth);
  const height = Math.max(1, Math.round((picture.height / picture.width) * width));
  return new Paragraph({
    children: [new ImageRun({ type: 'png', data: picture.data, transformation: { width, height }, altText: { title: alt, description: alt, name: alt } })],
    alignment: ALIGN[node.attrs?.align] || AlignmentType.LEFT,
    spacing: { after: 160 },
  });
}

function listBlocks(list, level, ctx) {
  const out = [];
  const ordered = list.type === 'orderedList';
  let reference = 'bullets';
  if (ordered) {
    ctx.orderedCount += 1;
    reference = `ordered-${ctx.orderedCount}`;
    ctx.numbering.push(orderedConfig(reference));
  }
  for (const item of list.content || []) {
    let first = true;
    for (const child of item.content || []) {
      if (child.type === 'paragraph') {
        out.push(paragraph(child, { numbering: first ? { reference, level } : undefined, indent: first ? undefined : { left: 720 + level * 360 }, after: 60 }));
        first = false;
      } else if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        out.push(...(child.type === 'taskList' ? taskBlocks(child, level + 1, ctx) : listBlocks(child, level + 1, ctx)));
      } else {
        out.push(...blocks([child], ctx));
      }
    }
  }
  return out;
}

function taskBlocks(list, level, ctx) {
  const out = [];
  for (const item of list.content || []) {
    const checked = Boolean(item.attrs?.checked);
    let first = true;
    for (const child of item.content || []) {
      if (child.type === 'paragraph') {
        const box = new TextRun({ text: checked ? '☑  ' : '☐  ', font: 'Segoe UI Symbol' });
        out.push(new Paragraph({
          children: [...(first ? [box] : []), ...inlineRuns(child.content, { color: checked ? '6B7280' : undefined })],
          indent: { left: 360 + level * 360, hanging: first ? 0 : -360 },
          spacing: { after: 60 },
        }));
        first = false;
      } else if (child.type === 'taskList') {
        out.push(...taskBlocks(child, level + 1, ctx));
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        out.push(...listBlocks(child, level + 1, ctx));
      } else {
        out.push(...blocks([child], ctx));
      }
    }
  }
  return out;
}

function orderedConfig(reference) {
  return {
    reference,
    levels: [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      format: level % 3 === 0 ? LevelFormat.DECIMAL : level % 3 === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.LOWER_ROMAN,
      text: `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
    })),
  };
}

function cellBlocks(cell, ctx) {
  const children = blocks(cell.content || [], ctx);
  return children.length ? children : [new Paragraph({ children: [] })];
}

function tableBlock(node, ctx) {
  const rows = node.content || [];
  const first = rows[0]?.content || [];
  const widths = first.map((cell) => (cell.attrs?.colwidth && cell.attrs.colwidth[0]) || null);
  let columnWidths;
  if (first.length && widths.every(Boolean)) {
    const total = widths.reduce((sum, w) => sum + w, 0) * TWIPS_PER_PX;
    const scale = total > MAX_TABLE_TWIPS ? MAX_TABLE_TWIPS / total : 1;
    columnWidths = widths.map((w) => Math.max(600, Math.floor(w * TWIPS_PER_PX * scale)));
  } else if (first.length) {
    columnWidths = first.map(() => Math.floor(MAX_TABLE_TWIPS / first.length));
  }
  return new Table({
    width: { size: columnWidths ? columnWidths.reduce((a, b) => a + b, 0) : MAX_TABLE_TWIPS, type: WidthType.DXA },
    columnWidths,
    borders: { top: GRID_BORDER, bottom: GRID_BORDER, left: GRID_BORDER, right: GRID_BORDER, insideHorizontal: GRID_BORDER, insideVertical: GRID_BORDER },
    rows: rows.map((row) => new TableRow({
      tableHeader: (row.content || []).every((cell) => cell.type === 'tableHeader'),
      children: (row.content || []).map((cell, index) => {
        const isHeader = cell.type === 'tableHeader';
        const align = ALIGN[cell.attrs?.align];
        const children = (cell.content || []).map((child) => (child.type === 'paragraph'
          ? paragraph(child, { alignment: align, after: 40, run: isHeader ? { bold: true } : undefined })
          : null)).filter(Boolean);
        return new TableCell({
          children: children.length ? children : [new Paragraph({ children: [] })],
          width: columnWidths ? { size: columnWidths[index] || columnWidths[columnWidths.length - 1], type: WidthType.DXA } : undefined,
          shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F3F4F6' } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
      }),
    })),
  });
}

function calloutBlock(node, ctx) {
  const color = CALLOUT_COLORS[node.attrs?.type] || CALLOUT_COLORS.info;
  return new Table({
    width: { size: MAX_TABLE_TWIPS, type: WidthType.DXA },
    columnWidths: [MAX_TABLE_TWIPS],
    borders: { top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER, left: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: MAX_TABLE_TWIPS, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: color.fill },
        borders: { left: { style: BorderStyle.SINGLE, size: 24, color: color.bar }, top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER },
        margins: { top: 100, bottom: 100, left: 160, right: 160 },
        children: cellBlocks(node, ctx),
      })],
    })],
  });
}

function blocks(nodes = [], ctx) {
  const out = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(paragraph(node));
        break;
      case 'heading': {
        const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 1));
        out.push(new Paragraph({ heading: HEADINGS[level], children: inlineRuns(node.content), keepNext: true }));
        break;
      }
      case 'bulletList':
      case 'orderedList':
        out.push(...listBlocks(node, 0, ctx));
        break;
      case 'taskList':
        out.push(...taskBlocks(node, 0, ctx));
        break;
      case 'blockquote':
        for (const child of node.content || []) {
          if (child.type === 'paragraph') {
            out.push(paragraph(child, {
              indent: { left: 360 },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D5DB', space: 8 } },
              run: { color: '4B5563', italics: true },
            }));
          } else {
            out.push(...blocks([child], ctx));
          }
        }
        break;
      case 'codeBlock':
        for (const line of plainText(node).split('\n')) {
          out.push(new Paragraph({
            children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })],
            shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
            spacing: { after: 0 },
          }));
        }
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case 'horizontalRule':
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } }, spacing: { before: 120, after: 200 } }));
        break;
      case 'table':
        out.push(tableBlock(node, ctx), new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case 'callout':
        out.push(calloutBlock(node, ctx), new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case 'image':
        out.push(imageParagraph(node, ctx));
        break;
      default:
        if (node.content) out.push(paragraph({ content: [{ type: 'text', text: plainText(node) }] }));
    }
  }
  return out;
}

// `doc` is editor.getJSON(); `images` maps a file id to { data: Buffer, width, height } (a PNG).
async function buildDocx({ title, doc, images = {} }) {
  const ctx = {
    images,
    numbering: [{
      reference: 'bullets',
      levels: [0, 1, 2, 3, 4, 5].map((level) => ({
        level,
        format: LevelFormat.BULLET,
        text: ['•', '◦', '▪'][level % 3],
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
      })),
    }],
    orderedCount: 0,
  };
  const content = (doc && doc.content) || [];
  const children = [];
  const first = content[0];
  const startsWithTitle = first && first.type === 'heading' && plainText(first).trim() === String(title || '').trim();
  if (title && !startsWithTitle) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })], spacing: { after: 240 } }));
  }
  children.push(...blocks(content, ctx));
  if (!children.length) children.push(new Paragraph({ children: [] }));

  const heading = (id, name, size, before, after) => ({
    id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true,
    run: { size, bold: true, color: '111827', font: 'Calibri' },
    paragraph: { spacing: { before, after }, keepNext: true },
  });
  const document = new Document({
    creator: 'IT Avenue Workspace',
    title: title || 'Canvas',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 44, bold: true, color: '111827', font: 'Calibri' }, paragraph: { spacing: { after: 240 } } },
        heading('Heading1', 'Heading 1', 36, 320, 140),
        heading('Heading2', 'Heading 2', 30, 280, 120),
        heading('Heading3', 'Heading 3', 26, 240, 100),
        heading('Heading4', 'Heading 4', 23, 200, 80),
      ],
    },
    numbering: { config: ctx.numbering },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

module.exports = { buildDocx, plainText };
