// IT Avenue Workspace - saving the org chart as an image (SVG, or PNG made from it).
//
// The chart on screen is HTML and CSS, so the picture is drawn from the same data instead: orgChartLayout places the cards (what is
// on screen: the search filter and the collapsed teams), orgChartSvg turns the layout into a standalone SVG. Both are pure and
// tested. The part that fetches photos, makes the PNG and downloads the file is at the bottom and runs only in the app.

const ORG_EXPORT_DEFAULTS = { cardWidth: 230, cardHeight: 84, gapX: 24, gapY: 52, rootGap: 64, padding: 32 };
const ORG_EXPORT_CAPTION_HEIGHT = 30;

const orgExportTeamSize = (node) => node.children.reduce((sum, child) => sum + 1 + orgExportTeamSize(child), 0);

// Places the cards: { nodes: [{ id, person, x, y, width, height, matched, hidden }], links: [{ from, to }], width, height }.
// `roots` is the tree from buildOrgTree/filterOrgTree; `collapsed` is a Set of person ids whose team is hidden (`hidden` counts them).
function orgChartLayout(roots, options = {}) {
  const o = { ...ORG_EXPORT_DEFAULTS, ...options };
  const collapsed = options.collapsed || new Set();
  const nodes = [];
  const links = [];

  const measure = (node) => {
    const closed = collapsed.has(Number(node.person.id));
    const kids = closed ? [] : node.children.map(measure);
    const kidsSpan = kids.length ? kids.reduce((sum, kid) => sum + kid.span, 0) + o.gapX * (kids.length - 1) : 0;
    return { node, kids, kidsSpan, span: Math.max(o.cardWidth, kidsSpan), hidden: closed ? orgExportTeamSize(node) : 0 };
  };
  const levels = (m) => 1 + (m.kids.length ? Math.max(...m.kids.map(levels)) : 0);
  const place = (m, left, top) => {
    const id = Number(m.node.person.id);
    nodes.push({ id, person: m.node.person, x: left + (m.span - o.cardWidth) / 2, y: top, width: o.cardWidth, height: o.cardHeight, matched: Boolean(m.node.matched), hidden: m.hidden });
    let cursor = left + (m.span - m.kidsSpan) / 2;
    for (const kid of m.kids) {
      links.push({ from: id, to: Number(kid.node.person.id) });
      place(kid, cursor, top + o.cardHeight + o.gapY);
      cursor += kid.span + o.gapX;
    }
  };

  const measured = roots.map(measure);
  if (!measured.length) return { nodes, links, width: o.padding * 2 + o.cardWidth, height: o.padding * 2 + o.cardHeight };
  const maxSpan = Math.max(...measured.map((m) => m.span));
  let top = o.padding;
  for (const m of measured) {
    place(m, o.padding + (maxSpan - m.span) / 2, top);
    top += levels(m) * o.cardHeight + (levels(m) - 1) * o.gapY + o.rootGap;
  }
  return { nodes, links, width: o.padding * 2 + maxSpan, height: top - o.rootGap + o.padding };
}

function orgExportEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fits text to roughly `chars` characters, ending with an ellipsis when it was cut (SVG has no automatic ellipsis).
function orgExportFit(text, chars) {
  const value = String(text || '').trim();
  return value.length > chars ? `${value.slice(0, Math.max(1, chars - 1)).trimEnd()}…` : value;
}

// A standalone SVG of the layout. Options: nameOf(person), avatarFor(person) -> { color, initial, photo? (a data: URL) },
// secondary: [{ person, manager }] (ids) for the dashed "also reports to" lines, caption: a line of text under the chart.
function orgChartSvg(layout, { nameOf = (person) => person.username || '', avatarFor = null, secondary = [], caption = '' } = {}) {
  const o = ORG_EXPORT_DEFAULTS;
  const height = layout.height + (caption ? ORG_EXPORT_CAPTION_HEIGHT : 0);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const font = 'font-family="Lato, \'Segoe UI\', Arial, Helvetica, sans-serif"';

  const elbow = layout.links.map((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height;
    const x2 = to.x + to.width / 2;
    const middle = y1 + (to.y - y1) / 2;
    return `<path data-org-link="${link.from}:${link.to}" d="M${x1} ${y1} V${middle} H${x2} V${to.y}" fill="none" stroke="#c9c4cc" stroke-width="2" stroke-linejoin="round"/>`;
  }).join('');

  const dotted = secondary.filter((line) => byId.has(Number(line.person)) && byId.has(Number(line.manager))).map((line) => {
    const person = byId.get(Number(line.person));
    const manager = byId.get(Number(line.manager));
    const x1 = manager.x + manager.width / 2;
    const y1 = manager.y + manager.height;
    const x2 = person.x + person.width / 2;
    const y2 = person.y;
    const bend = Math.max(24, Math.abs(y2 - y1) / 2);
    return `<path data-org-dotted="${line.person}:${line.manager}" d="M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}" fill="none" stroke="#646364" stroke-width="2" stroke-dasharray="6 5" opacity="0.75"/>`;
  }).join('');

  const textX = 14 + 44 + 12;
  const room = o.cardWidth - textX - 12;
  const cards = layout.nodes.map((node) => {
    const p = node.person;
    const name = nameOf(p) || '?';
    const look = (avatarFor && avatarFor(p)) || { color: '#6B21A8', initial: name.charAt(0).toUpperCase() };
    const cx = node.x + 14 + 22;
    const cy = node.y + node.height / 2;
    const avatar = look.photo
      ? `<clipPath id="clip-${node.id}"><rect x="${cx - 22}" y="${cy - 22}" width="44" height="44" rx="11"/></clipPath><image href="${orgExportEscape(look.photo)}" x="${cx - 22}" y="${cy - 22}" width="44" height="44" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip-${node.id})"/>`
      : `<rect x="${cx - 22}" y="${cy - 22}" width="44" height="44" rx="11" fill="${orgExportEscape(look.color)}"/><text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="18" font-weight="700" fill="#ffffff" ${font}>${orgExportEscape(look.initial)}</text>`;
    const tx = node.x + textX;
    const lines = [
      `<text x="${tx}" y="${node.y + 31}" font-size="14" font-weight="700" fill="#1D1C1D" ${font}>${orgExportEscape(orgExportFit(name, Math.floor(room / 7.6)))}</text>`,
      p.jobTitle ? `<text x="${tx}" y="${node.y + 49}" font-size="12" fill="#646364" ${font}>${orgExportEscape(orgExportFit(p.jobTitle, Math.floor(room / 6.2)))}</text>` : '',
      p.department ? `<text x="${tx}" y="${node.y + 66}" font-size="11" font-style="italic" fill="#5F2D82" ${font}>${orgExportEscape(orgExportFit(p.department, Math.floor(room / 5.8)))}</text>` : '',
      node.hidden ? `<text x="${node.x + node.width - 12}" y="${node.y + node.height - 8}" text-anchor="end" font-size="11" font-weight="700" fill="#5F2D82" ${font}>+${node.hidden} hidden</text>` : '',
    ].join('');
    return `<rect data-org-card="${node.id}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="#ffffff" stroke="${node.matched ? '#7c3aed' : '#E3DFE5'}" stroke-width="${node.matched ? 2.5 : 1.5}"/>${avatar}${lines}`;
  }).join('');

  const footer = caption ? `<text x="${o.padding}" y="${layout.height + 14}" font-size="11" fill="#8a898b" ${font}>${orgExportEscape(caption)}</text>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${height}" viewBox="0 0 ${layout.width} ${height}"><rect width="${layout.width}" height="${height}" fill="#ffffff"/>${elbow}${dotted}${cards}${footer}</svg>`;
}

function orgChartFileName(date, extension) {
  const two = (n) => String(n).padStart(2, '0');
  return `org-chart-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.${extension}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { orgChartLayout, orgChartSvg, orgChartFileName };
}

// ---- everything below touches the page and runs only in the app; it is exercised in the browser, not in node ----

function orgExportBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// The photo as a data: URL so the image is self-contained (null when there is none).
async function orgExportPhoto(person) {
  if (!person.photoVersion || typeof userPhotoUrl !== 'function') return null;
  try {
    const url = await userPhotoUrl(person);
    if (!url) return null;
    return await orgExportBlobToDataUrl(await (await fetch(url)).blob());
  } catch (err) { return null; }
}

function orgExportDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Draws the SVG on a canvas (twice as sharp as it is, but never more than 8000 px on a side) and returns a PNG Blob.
function orgExportPng(svg, width, height) {
  return new Promise((resolve, reject) => {
    const scale = Math.max(0.25, Math.min(2, 8000 / Math.max(width, height)));
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not make the image'))), 'image/png');
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not make the image')); };
    image.src = url;
  });
}

// Saves the chart as it is on screen (the search filter and collapsed teams apply). format: 'svg' | 'png'.
async function exportOrgChart(format) {
  const people = peopleState.list || [];
  const tree = filterOrgTree(buildOrgTree(people), peopleState.query);
  if (!tree.length) { showToast('There is nothing to save yet.', 'info'); return; }
  try {
    const layout = orgChartLayout(tree, { collapsed: peopleState.collapsed });
    const looks = new Map();
    await Promise.all(layout.nodes.map(async (node) => {
      const p = node.person;
      looks.set(p.id, {
        color: /^#[0-9a-fA-F]{6}$/.test(p.avatarColor || '') ? p.avatarColor : '#6B21A8',
        initial: (personName(p) || '?').charAt(0).toUpperCase(),
        photo: await orgExportPhoto(p),
      });
    }));
    const today = new Date();
    const svg = orgChartSvg(layout, {
      nameOf: personName, avatarFor: (p) => looks.get(p.id),
      secondary: people.flatMap((p) => (p.secondaryManagerIds || []).map((manager) => ({ person: p.id, manager }))),
      caption: `IT Avenue Workspace · Org chart · ${today.toLocaleDateString([], { dateStyle: 'medium' })}`,
    });
    if (format === 'png') {
      const height = layout.height + ORG_EXPORT_CAPTION_HEIGHT;
      orgExportDownload(await orgExportPng(svg, layout.width, height), orgChartFileName(today, 'png'));
    } else {
      orgExportDownload(new Blob([svg], { type: 'image/svg+xml' }), orgChartFileName(today, 'svg'));
    }
  } catch (err) { showToast(err.message || 'Could not save the chart.', 'error'); }
}
