import DOMPurify from 'dompurify';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkStringify from 'remark-stringify';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { Settings } from '../shared/meki';
import { WritingEditor } from './editor';
import { t } from '../electron/i18n.mjs';
import { researchLinkId } from '../electron/research-links.mjs';
import type { ResearchDocument, ResearchSearchLocator, ResearchSnapshot } from '../shared/research';
import { renderMarkdown } from './markdown-render';
import { revealResearchPassage } from './research-search-location';
import './research-subscription.css';

export function sharedMarkdown(markdown: string) {
  return DOMPurify.sanitize(renderMarkdown(markdown).html, {
    RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: ['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','strong','em','del','pre','code','br','hr','sub','sup','a'],
    ALLOWED_ATTR: ['href','id','colspan','rowspan','start'], ALLOWED_URI_REGEXP: /^(?:mekir:|#)/i,
  });
}

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);

function readerMarkdown(doc: ResearchDocument, state: ResearchSnapshot) {
  const root = markdown.parse(doc.body) as Root;
  const ids = new Set(state.documents.map(ref => ref.id));
  const allowed = (url: string) => url.startsWith('#') || ids.has(researchLinkId(url) || '');
  // Resolve no publisher-local files or embedded remote resources on the reading device.
  const clean = (node: RootContent): RootContent[] => {
    if (node.type === 'image' || node.type === 'imageReference') return [{ type: 'text', value: node.alt || '' }];
    if (node.type === 'html') return [{ type: 'text', value: node.value }];
    if (node.type === 'definition' && !allowed(node.url)) return [];
    if ('children' in node) node.children = node.children.flatMap(clean) as PhrasingContent[];
    if (node.type === 'link' && !allowed(node.url)) return node.children;
    return [node];
  };
  root.children = root.children.flatMap(clean);
  if (!root.children.some(node => node.type === 'heading' && node.depth === 1)) {
    root.children.unshift({ type: 'heading', depth: 1, children: [{ type: 'text', value: doc.record.title }] });
  }
  return markdown.stringify(root);
}

export class SubscribedReader {
  readonly surface = document.createElement('div');
  document?: ResearchDocument;
  private history: { id: string; scroll: number; anchor?: string }[] = [];
  private generation = 0;

  editor?: WritingEditor;
  private initializing?: Promise<WritingEditor>;
  private visual = window.document.createElement('div');
  private note = window.document.createElement('p');

  constructor(private follow: (id: string) => Promise<void>, private settings: () => Settings,
    private created: (editor: WritingEditor) => void, private notify: (message: string, error?: boolean) => void) {
    this.surface.id = 'research-shared-document';
    this.surface.className = 'document-scroll';
    this.visual.className = 'editor-host';
    this.note.className = 'research-shared-note';
    this.surface.append(this.visual, this.note);
    this.surface.tabIndex = -1;
    this.surface.hidden = true;
    window.document.getElementById('research-reader-related')!.parentElement!.after(this.surface);
    this.surface.addEventListener('click', event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a');
      if (!link) return;
      event.preventDefault(); event.stopPropagation();
      const href = link.getAttribute('href') || '';
      const id = researchLinkId(href);
      if (id) void this.follow(id).catch(error => this.notify(String(error), true));
      else if (href.startsWith('#')) {
        const heading = [...this.visual.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === href.slice(1));
        heading?.scrollIntoView();
      }
    });
  }

  private prepare() {
    return this.initializing ??= (async () => {
      const source = window.document.createElement('div');
      source.hidden = true; this.surface.append(source);
      const editor = new WritingEditor(this.visual, source, () => {}, () => null, message => this.notify(message, true));
      try {
        await editor.create(); editor.setReadOnly(true);
        this.visual.querySelector('.ProseMirror')!.classList.add('meki-document');
        this.created(editor);
        return this.editor = editor;
      } catch (error) {
        await editor.destroy(); source.remove(); this.initializing = undefined; throw error;
      }
    })();
  }

  get canGoBack() { return this.history.length > 0; }

  async open(state: ResearchSnapshot, id: string, fromList: boolean, locator?: ResearchSearchLocator) {
    const request = ++this.generation;
    const [doc] = await Promise.all([window.meki.readResearchRecord(state.root, id), this.prepare()]);
    if (request !== this.generation) return false;
    if (fromList) this.history = [];
    else if (this.document && this.document.record.id !== id) {
      const anchor = window.document.activeElement?.closest('a')?.getAttribute('href');
      this.history.push({ id: this.document.record.id, scroll: this.surface.scrollTop, anchor: anchor || undefined });
    }
    this.render(state, doc);
    if (locator?.kind === 'paragraph' || locator?.kind === 'trial') {
      requestAnimationFrame(() => { if (this.document === doc) revealResearchPassage(this.surface, locator, doc.body); });
    }
    return true;
  }

  async back(state: ResearchSnapshot) {
    const previous = this.history.pop();
    if (!previous) return false;
    const request = ++this.generation;
    const doc = await window.meki.readResearchRecord(state.root, previous.id);
    if (request !== this.generation) return false;
    this.render(state, doc);
    const link = previous.anchor && this.surface.querySelector<HTMLElement>('a[href="' + CSS.escape(previous.anchor) + '"]');
    if (link) link.focus({ preventScroll: true });
    this.surface.scrollTop = previous.scroll;
    return true;
  }

  async refresh(state: ResearchSnapshot) {
    this.history = this.history.filter(step => state.records.some(entry => entry.record.id === step.id));
    const current = this.document;
    if (!current) return;
    const entry = state.records.find(item => item.record.id === current.record.id);
    if (!entry || entry.revision === current.revision) return;
    const request = ++this.generation;
    const doc = await window.meki.readResearchRecord(state.root, entry.record.id);
    if (request !== this.generation || current !== this.document) return;
    const scroll = this.surface.scrollTop;
    this.render(state, doc);
    this.surface.scrollTop = scroll;
  }

  private render(state: ResearchSnapshot, doc: ResearchDocument) {
    this.document = doc;
    const editor = this.editor!;
    editor.updateSettings(this.settings());
    editor.load(readerMarkdown(doc, state));
    editor.setReadOnly(true);
    this.note.hidden = !doc.excerptOnly;
    this.note.textContent = doc.body ? t("已分享摘要，完整正文保存在发布端。") : t("发布者尚未分享这条记录的正文。");
    this.surface.hidden = false;
    this.surface.scrollTop = 0;
  }

  close() {
    this.generation++; this.history = [];
    if (this.document) this.editor?.load('');
    this.document = undefined;
    this.surface.hidden = true;
    this.editor?.cancelPendingActions();
  }
}
