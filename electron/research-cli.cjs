#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ResearchStore } = require('./research-store.cjs');
const { MANIFEST, RECORDS, FIELD_TYPES, TEMPLATE_KEYS, assert, date, id } = require('./research-model.cjs');
const { exampleProject, exampleRecords } = require('./research-example.cjs');
const { PRODUCT_NAME } = require('./app-identity.cjs');

const usage = `${PRODUCT_NAME} research projects

  init-demo <folder>
  init <folder> --input <project.json|->
  describe <folder>
  list <folder> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--phase ID] [--type ID]
  read <folder> <record-id>
  batch <folder> --input <batch.json|->
  configure <folder> --input <configuration.json|->

Results are JSON. Use --input - to read JSON from stdin.
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
      help: { type: 'boolean', short: 'h' }, input: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, phase: { type: 'string' }, type: { type: 'string' },
    },
  });
  const [command, folder, recordId, ...extra] = positionals;
  if (!command || command === 'help' || values.help) { process.stdout.write(usage); return undefined; }
  assert(['init-demo', 'init', 'describe', 'list', 'read', 'batch', 'configure'].includes(command), `Unknown command: ${command}. Run --help.`);
  assert(folder && !extra.length && (command === 'read' ? recordId : !recordId), 'Provide the project folder and, for read, a record ID.');
  const allowedOptions = command === 'list' ? ['from', 'to', 'phase', 'type'] : ['init', 'batch', 'configure'].includes(command) ? ['input'] : [];
  for (const key of Object.keys(values)) assert(allowedOptions.includes(key), `--${key} is not used by ${command}.`);
  const root = path.resolve(folder);
  if (command === 'init' || command === 'init-demo') {
    const config = command === 'init' ? await readInput(values.input) : exampleProject;
    const store = await ResearchStore.initialize(root, config, command === 'init-demo' ? exampleRecords : []);
    const { project, revision } = await store.manifest();
    return { root: store.root, id: project.id, revision };
  }
  const store = await ResearchStore.open(root);
  assert(store, `Could not find ${MANIFEST} in ${root}.`);
  if (command === 'describe') {
    const { project, revision } = await store.manifest();
    return {
      root: store.root, revision, project,
      format: {
        manifest: MANIFEST, recordPath: `${RECORDS}/r-<id>.md`, dateFormat: 'YYYY-MM-DD',
        fieldTypes: FIELD_TYPES, templateVariables: [...TEMPLATE_KEYS, 'field.<id>'],
        summary: { date: 'date written', coverage: { start: 'inclusive date', end: 'inclusive date' }, sources: 'record IDs' },
      },
      writes: {
        batch: {
          input: { ifProjectRevision: 'revision from describe (optional)', records: [{ id: 'stable record ID', ifRevision: 'revision from read or null for creation', type: 'configured type ID', title: 'single line', date: 'date of record', phaseId: 'configured phase ID or null', coverage: 'summary interval or null', sources: 'record IDs', fields: 'patch keyed by field ID; null clears a value', body: 'Markdown; omission keeps the existing body or applies the template on creation' }] },
          relationships: 'Place new source records before summaries that cite them.',
        },
        configure: { input: { ifRevision: 'revision from describe', project: 'updated copy of project' } },
      },
    };
  }
  if (command === 'read') return store.read(recordId);
  if (command === 'batch') return store.writeBatch(await readInput(values.input));
  if (command === 'configure') return store.configure(await readInput(values.input));
  if (values.from !== undefined) date(values.from, '--from');
  if (values.to !== undefined) date(values.to, '--to');
  if (values.from && values.to) assert(values.from <= values.to, '--from must be on or before --to.');
  if (values.phase !== undefined) id(values.phase, '--phase');
  if (values.type !== undefined) id(values.type, '--type');
  const { project, revision, records, problems } = await store.snapshot();
  if (values.phase) assert(project.phases.some(phase => phase.id === values.phase), `Unknown phase: ${values.phase}.`);
  if (values.type) assert(project.recordTypes.some(type => type.id === values.type), `Unknown type: ${values.type}.`);
  return { projectRevision: revision, problems, records: records.filter(({ record }) =>
    (!values.from || record.date >= values.from) && (!values.to || record.date <= values.to) &&
    (!values.phase || record.phaseId === values.phase) && (!values.type || record.type === values.type))
    .sort((a, b) => b.record.date.localeCompare(a.record.date) || a.record.id.localeCompare(b.record.id)) };
}

main(process.argv.slice(2)).then(result => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code || 'RESEARCH_INPUT' }) + '\n');
  process.exitCode = 1;
});
