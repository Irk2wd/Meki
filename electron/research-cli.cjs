#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ResearchStore } = require('./research-store.cjs');
const { MANIFEST, LEGACY_MANIFEST, INDEX, SUMMARIES, DOCUMENT_SCHEME, RECORDS, FIELD_TYPES, TEMPLATE_KEYS, RELATION_KINDS, RUN_FILTER_FIELDS, assert, date, id, comparisonType } = require('./research-model.cjs');
const { comparisonLimits } = require('./research-comparison.mjs');
const { newExampleProject, exampleRecords } = require('./research-example.cjs');
const { PRODUCT_NAME } = require('./app-identity.cjs');

const usage = `${PRODUCT_NAME} research projects

  init-demo <folder>
  init <folder> --input <project.json|->
  describe <folder>
  list <folder> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--phase ID] [--type ID]
                [--query TERMS] [--month YYYY-MM] [--field FIELD=VALUE]... [--filter ID]
  read <folder> <record-id>
  sources <folder>
  bind-source <folder> <source-id> --path <local-folder> [--label <new-source-name>]
  index <folder> <document-id> --path <relative-file> [--source <source-id>] [--label <title>]
  resolve <folder> <document-id> [--local]
  import-archive <folder> <source-id> [--confirm <preview-token>]
  save-filter <folder> --label <name> --input <filter.json|->
  batch <folder> --input <batch.json|->
  configure <folder> --input <configuration.json|->

Results are JSON. Use --input - to read JSON from stdin.
Run describe before writing to discover the project's current fields, templates, instructions, and revision.
`;

async function readInput(input) {
  assert(typeof input === 'string' && input.length, 'Provide --input with a JSON file or - for stdin.');
  if (input !== '-') return JSON.parse(await fs.readFile(input, 'utf8'));
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}

async function main(args) {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, input: { type: 'string' }, path: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, phase: { type: 'string' }, type: { type: 'string' },
      source: { type: 'string' }, label: { type: 'string' }, local: { type: 'boolean' }, confirm: { type: 'string' },
      query: { type: 'string' }, month: { type: 'string' }, field: { type: 'string', multiple: true }, filter: { type: 'string' },
    },
  });
  const [command, folder, documentId, ...extra] = positionals;
  if (!command || command === 'help' || values.help) { process.stdout.write(usage); return undefined; }
  assert(['init-demo', 'init', 'describe', 'list', 'read', 'index', 'resolve', 'batch', 'configure', 'sources', 'bind-source', 'import-archive', 'save-filter'].includes(command), `Unknown command: ${command}. Run --help.`);
  const needsId = ['read', 'index', 'resolve', 'bind-source', 'import-archive'].includes(command);
  assert(folder && !extra.length && Boolean(documentId) === needsId, needsId ? 'Provide the project folder and an ID.' : 'Provide the project folder.');
  const optionsByCommand = { list: ['from', 'to', 'phase', 'type', 'query', 'month', 'field', 'filter'], init: ['input'], batch: ['input'], configure: ['input'],
    index: ['path', 'source', 'label'], 'bind-source': ['path', 'label'], resolve: ['local'], 'import-archive': ['confirm'], 'save-filter': ['input', 'label'] };
  const allowedOptions = optionsByCommand[command] || [];
  for (const key of Object.keys(values)) assert(allowedOptions.includes(key), `--${key} is not used by ${command}.`);
  const root = path.resolve(folder);
  if (command === 'init' || command === 'init-demo') {
    const config = command === 'init' ? await readInput(values.input) : newExampleProject();
    const store = await ResearchStore.initialize(root, config, command === 'init-demo' ? exampleRecords : []);
    const { project, revision } = await store.manifest();
    return { root: store.root, id: project.id, revision };
  }
  const store = await ResearchStore.open(root);
  assert(store, `Could not find ${MANIFEST} or ${LEGACY_MANIFEST} in ${root}.`);
  if (command === 'describe') {
    const { project, revision } = await store.manifest();
    return {
      root: store.root, revision, project,
      format: {
        manifest: store.manifestFile, recordPath: `${RECORDS}/r-<id>.md`,
        summaryPath: `${store.summaryPath ? SUMMARIES : RECORDS}/r-<id>.md`,
        ...(store.indexPath ? { index: INDEX, documentLink: `${DOCUMENT_SCHEME}<id>` } : {}),
        dateFormat: 'YYYY-MM-DD',
        fieldTypes: FIELD_TYPES, templateVariables: [...TEMPLATE_KEYS, 'field.<id>'],
        rules: {
          guide: 'AGENTS.md in the project root, when present',
          instructions: 'project.instructions',
          recordTypes: 'Read project.recordTypes. Match record.type to the record type ID, then read its fields and template.',
          fields: 'Use field IDs as keys. Read each field’s type, description, unit, required, min, max, options and default. Use JSON numbers in the configured unit, JSON booleans, YYYY-MM-DD date strings and exact choice values.',
          views: 'Read project.views and project.defaultView. Fields listed in a view affect display only.',
        },
        relationKinds: RELATION_KINDS, archiveFilterFields: RUN_FILTER_FIELDS,
        phase: { start: 'required inclusive date', end: 'inclusive date when known. Omit or set to null for an ongoing or planned phase.' },
        comparison: {
          type: comparisonType(project).id, phaseId: 'required phase ID', body: 'Markdown caption', limits: comparisonLimits,
          comparison: { columns: ['column label'], rows: [{ label: 'row label', images: ['indexed image evidence ID or null for an empty cell'] }] },
          note: 'Provide one image slot per column in every row. The first comparison registers the default type when needed. Use the returned projectRevision for another write.',
        },
        summary: { date: 'date written', coverage: { start: 'inclusive date', end: 'inclusive date' }, sources: 'document IDs from list or resolve',
          relatedProjects: 'IDs from the other projects’ describe output' },
      },
      writes: {
        batch: {
          input: { ifProjectRevision: 'revision from describe (optional)', records: [{ id: 'stable record ID', ifRevision: 'revision from read or null for creation', type: 'configured type ID', title: 'single line', date: 'date of record', phaseId: 'configured phase ID or null', coverage: 'summary interval or null', sources: 'document IDs', fields: 'patch keyed by field ID; null clears a value', body: 'Markdown; omission keeps the existing body or applies the template on creation' }] },
          fieldRules: 'Defaults fill omitted fields on creation only. Omitted fields on update keep their current values. Use null to clear an optional value. New or changed values must meet the current rules. List records to see issues on historical values.',
          revisionConflict: 'On RESEARCH_CONFLICT, run describe again, read affected records, and merge changes before retrying.',
          relationships: 'Use evidence: [indexed file ID], relations: [{kind, target, note?}], and relatedProjects: [other project IDs] for summaries. Place new source records before summaries that cite them.',
        },
        configure: {
          input: { ifRevision: 'revision from describe', project: 'updated copy of project' },
          fieldRules: 'Keep existing IDs when changing labels. Add a new field ID for a new meaning or unit. Update references in templates and views, then read the new revision before batching records.',
        },
      },
    };
  }
  if (command === 'read') return store.read(documentId);
  if (command === 'resolve') {
    const reference = await store.resolveDocument(documentId);
    if (!values.local) return reference;
    return { ...reference, path: reference.sourceId ? (await store.evidenceFile(documentId)).file.path : path.join(store.root, reference.relativePath) };
  }
  if (command === 'index') {
    assert(!values.label || values.source, '--label is used for external evidence indexed with --source.');
    return values.source ? store.indexEvidence(documentId, { sourceId: values.source, relativePath: values.path,
      title: values.label || path.posix.basename(values.path || '') }) : store.indexDocument(documentId, values.path);
  }
  if (command === 'sources') return (await store.snapshot()).evidenceSources || [];
  if (command === 'bind-source') {
    assert(values.path, 'Provide the local directory with --path.');
    return store.bindEvidenceSource(documentId, path.resolve(values.path), values.label);
  }
  if (command === 'import-archive') return store.importArchive(documentId, values.confirm);
  if (command === 'save-filter') return store.saveFilter(values.label, await readInput(values.input));
  if (command === 'batch') return store.writeBatch(await readInput(values.input));
  if (command === 'configure') return store.configure(await readInput(values.input));
  if (values.from !== undefined) date(values.from, '--from');
  if (values.to !== undefined) date(values.to, '--to');
  if (values.from && values.to) assert(values.from <= values.to, '--from must be on or before --to.');
  if (values.phase !== undefined) id(values.phase, '--phase');
  if (values.type !== undefined) id(values.type, '--type');
  let saved;
  if (values.filter) {
    saved = (await store.manifest()).project.savedFilters?.find(filter => filter.id === values.filter);
    assert(saved, `Unknown saved filter: ${values.filter}.`);
  }
  const filter = {};
  const query = [saved?.query, values.query].filter(Boolean).join(' + ');
  if (query) filter.query = query;
  const month = values.month ?? saved?.month;
  if (month !== undefined) filter.month = month;
  const fields = [...(saved?.fields || []), ...(values.field || []).map(entry => {
    const equals = entry.indexOf('=');
    assert(equals > 0, 'Write field matches as FIELD=VALUE.');
    return { field: entry.slice(0, equals), value: entry.slice(equals + 1) };
  })];
  if (fields.length) filter.fields = fields;
  const { project, revision, records, documents, problems, matchingIds } = await store.snapshot(Object.keys(filter).length ? filter : undefined);
  const matched = matchingIds && new Set(matchingIds);
  if (values.phase) assert(project.phases.some(phase => phase.id === values.phase), `Unknown phase: ${values.phase}.`);
  if (values.type) assert(project.recordTypes.some(type => type.id === values.type), `Unknown type: ${values.type}.`);
  return { projectRevision: revision, problems, documents, records: records.filter(({ record }) =>
    (!values.from || record.date >= values.from) && (!values.to || record.date <= values.to) &&
    (!values.phase || record.phaseId === values.phase) && (!values.type || record.type === values.type) && (!matched || matched.has(record.id)))
    .sort((a, b) => b.record.date.localeCompare(a.record.date) || a.record.id.localeCompare(b.record.id)) };
}

main(process.argv.slice(2)).then(result => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code || 'RESEARCH_INPUT' }) + '\n');
  process.exitCode = 1;
});
