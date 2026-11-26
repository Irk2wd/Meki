'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trialRows, parseTable, measure } = require('../electron/research-measurements.cjs');
test('numeric citations retain logical source rows, group filters, precision and missing data', () => {
  const table=parseTable({kind:'csv',content:'view,layers,ms,notes\r\ntrail,3,10,"a\nb"\r\ncanopy,3,90,\r\ntrail,3,20,\r\ntrail,7,40,\r\n',revision:'rev'});
  const rule={column:'ms',where:{view:'trail',layers:'3'},statistic:'median'};
  assert.deepEqual(measure(table,rule,'15.00'),{kind:'cells',rows:[1,3],column:3,revision:'rev'});
  assert.equal(measure(table,rule,'待补'),undefined);
  assert.equal(measure(table,rule,'15.01'),undefined);
  assert.equal(measure(table,{...rule,where:{camera:'trail'}},'15'),undefined);
  const trial=trialRows('## Trials\n\n| Trial ID | Date | condition | file |\n| --- | --- | --- | --- |\n| t | 2025-02-02 | A \\| B | [raw](mekir:data) |')[0];
  assert.deepEqual(trial.links,['data']); assert.equal(trial.values[2],'A | B');
});
