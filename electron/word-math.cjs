'use strict';
const path = require('node:path');
const tags = new Set('math mrow mi mn mo mtext mspace mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mstyle mfenced mmultiscripts mprescripts none'.split(' '));
const attributes = new Set('display mathvariant displaystyle scriptlevel stretchy fence separator accent accentunder largeop movablelimits symmetric form lspace rspace minsize maxsize mathsize linebreak columnalign rowalign columnspacing rowspacing equalrows equalcolumns columnlines rowlines frame framespacing align side minlabelspacing width height depth linethickness numalign denomalign bevelled open close separators'.split(' '));

// MathML here is data for Pandoc, never arbitrary HTML. The subset intentionally
// excludes links, annotations, styles, external resources and special layouts.
function safeMathml(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || !/^<math\b[^>]*>[\s\S]*<\/math>$/.test(value)) return false;
  if (/<!|<\?|[\uE000-\uF8FF]/.test(value)) return false;
  for (const entity of value.matchAll(/&#(?:x([\da-f]+)|(\d+));/gi)) {
    const code = parseInt(entity[1] || entity[2], entity[1] ? 16 : 10);
    if ((code >= 0xE000 && code <= 0xF8FF) || code >= 0xF0000) return false;
  }
  const stack = []; let end = 0, roots = 0;
  for (const token of value.matchAll(/<\/?([a-z][a-z0-9]*)\b([^<>]*)>/g)) {
    if (/[<>]/.test(value.slice(end, token.index))) return false;
    const [whole, tag, rest] = token; if (!tags.has(tag)) return false;
    if (whole.startsWith('</')) {
      if (rest.trim() || stack.pop() !== tag) return false;
    } else {
      if ((tag === 'math') !== (stack.length === 0)) return false;
      if (tag === 'math' && ++roots > 1) return false;
      let offset = 0;
      for (const attr of rest.matchAll(/\s+([a-z][a-z0-9-]*)="([^"]*)"/g)) {
        if (rest.slice(offset, attr.index).trim()) return false;
        if (attr[1] === 'xmlns') { if (tag !== 'math' || attr[2] !== 'http://www.w3.org/1998/Math/MathML') return false; }
        else if (!attributes.has(attr[1]) || !/^[a-z\d. +%_,;:()\[\]{}|\-]*$/i.test(attr[2])) return false;
        offset = attr.index + attr[0].length;
      }
      if (rest.slice(offset).trim()) return false;
      stack.push(tag);
    }
    end = token.index + whole.length;
  }
  return end === value.length && !stack.length;
}

async function prepareWordMath(ast, execute, folder) {
  const formulas = [], unique = new Map();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.t === 'Span') {
      const attributes = new Map(value.c?.[0]?.[2] || []);
      if (attributes.get('moye-word-formula') === '1') {
        const mathml = attributes.get('moye-word-math');
        const formula = { node: value, mathml: safeMathml(mathml) ? mathml : null };
        formulas.push(formula);
        if (formula.mathml && unique.size < 256 && !unique.has(mathml)) unique.set(mathml, unique.size);
        return;
      }
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(collect); else if (child && typeof child === 'object') collect(child);
  }
  collect(ast.blocks);
  const converted = new Map();
  if (unique.size) {
    try {
      const html = [...unique].map(([mathml, index]) => `<div id="moye-equation-${index}">${mathml}</div>`).join('');
      const parsed = JSON.parse((await execute(['--from=html', '--to=json', '--fail-if-warnings'], html)).toString('utf8'));
      for (const block of parsed.blocks) {
        if (block.t !== 'Div') continue;
        const index = Number(block.c[0][0].replace(/^moye-equation-/, ''));
        const children = block.c[1];
        const math = children.length === 1 && ['Plain', 'Para'].includes(children[0].t) && children[0].c.length === 1 && children[0].c[0].t === 'Math' ? children[0].c[0] : null;
        if (Number.isInteger(index) && math) converted.set(index, math);
      }
      // Check the actual Word writer before replacing any fallback image. No
      // unsupported equation is allowed to silently become plain TeX in DOCX.
      const probe = { ...parsed, meta: {}, blocks: [...converted.values()].map(math => ({ t: 'Para', c: [math] })) };
      if (probe.blocks.length) await execute(['--from=json', '--to=docx', '--standalone', '--fail-if-warnings', `--output=${path.join(folder, 'math-check.docx')}`], JSON.stringify(probe));
    } catch { converted.clear(); }
  }
  let editable = 0;
  for (const formula of formulas) {
    const math = formula.mathml && converted.get(unique.get(formula.mathml));
    if (math) { formula.node.t = 'Math'; formula.node.c = math.c; editable++; }
    else formula.node.c[0][2] = formula.node.c[0][2].filter(([key]) => !key.startsWith('moye-word-'));
  }
  return { editable, fallback: formulas.length - editable };
}
module.exports = { safeMathml, prepareWordMath };
