'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {searchProject}=require('./research-search.cjs');
const {markdownPassages,reportPassages}=require('./research-search-passages.cjs');
const {previewEvidence}=require('./research-evidence.cjs');
const {activityDates}=require('./research-phases.mjs');
const {trialRows,parseTable,measure,numerals}=require('./research-measurements.cjs');
const {digest,readBytes,decodeDocument,MAX_DOCUMENT_BYTES}=require('./file-store.cjs');
const formatOf = name=>/\.(?:md|markdown|mdown|txt)$/i.test(name)?'markdown':/\.(pdf|pptx)$/i.exec(name)?.[1].toLowerCase()||'file';
const safeText = value=>String(value || '').replace(/(?:file:\/\/\/|[a-z]:[\\\/]|\/(?:Users|home|Volumes)\/)[^\s)\]]+/gi,'[local path]');
const clip=(value,n=1200)=>safeText(value).slice(0,n);
const sameLocator=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

class Evidence {
  constructor(store,snapshot,config,query,signal) {
    this.store=store;this.snapshot=snapshot;this.config=config;this.query=query;this.signal=signal;
    this.docs=new Map(snapshot.documents.map(d=>[d.id,d]));
    this.records=new Map(snapshot.records.map(e=>[e.record.id,e]));
    this.members=new Map(); this.index=new Map();this.citations={};this.readRefs=new Set();this.sourceTables=new Map();this.tables=new Map();this.searches=[];
    for(const entry of snapshot.records){
      const rec=entry.record;
      for(const id of new Set([rec.id,...rec.sources||[],...rec.evidence||[],...rec.run?.evidence||[]])){
        if(!this.members.has(id))this.members.set(id,[]);this.members.get(id).push(entry);
      }
    }
  }
  visible(id) {
    const doc=this.docs.get(id);if(!doc)return false;
    if(doc.sourceId ? (!this.config.sourceIds.includes(doc.sourceId) || this.snapshot.project.search?.sourceIds && !this.snapshot.project.search.sourceIds.includes(doc.sourceId)) : !this.config.allowRecords)return false;
    const q=this.query;
    if(!q.phase && !q.from && !q.to)return true;
    return (this.members.get(id)||[]).some(e=>(!q.phase || e.record.phaseId===q.phase) && activityDates(e).some(d=>this.date(d)));
  }
  date(d){return (!this.query.from || d>=this.query.from) && (!this.query.to || d<=this.query.to);}
  ref(id,locator={kind:'document'},content='',revision) {
    if(!this.visible(id))return;
    const key=JSON.stringify([id,locator]);
    let ref=this.index.get(key);
    if(!ref){
      if(this.index.size>=240)return;
      ref='E'+(this.index.size+1);this.index.set(key,ref);const doc=this.docs.get(id);
      this.citations[ref]={id,title:doc.title,format:formatOf(doc.relativePath),locator,snippet:'',revision};
    }
    if(content)this.citations[ref].snippet=clip(content,1400);
    if(revision)this.citations[ref].revision=revision;
    return ref;
  }
  card(ref){const c=this.citations[ref];return c && {ref,title:clip(c.title,180),format:c.format,text:c.snippet,
    ...(c.locator.kind==='page'&&{page:c.locator.page}),...(c.locator.trialId&&{trial:c.locator.trialId,date:c.locator.date})};}
  async search(query) {
    this.signal?.throwIfAborted();
    const search=await searchProject(this.store,{...this.query,query,mode:'concept',limit:100});
    this.signal?.throwIfAborted();this.searches.push(clip(query,160));
    const matches=[];
    for(const doc of search.results){
      if(!this.visible(doc.id))continue;
      const hit=doc.hits[0],ref=this.ref(doc.id,hit.locator,hit.snippet);
      if(ref)matches.push(this.card(ref));
      if(matches.length>=8)break;
    }
    return matches;
  }
  async source(id) {
    if(!this.visible(id)||!this.docs.get(id).sourceId)return;
    const {file,source,reference}=await this.store.evidenceFile(id);
    return previewEvidence(file,reference,source);
  }
  async csv(id) {
    if(!this.sourceTables.has(id)){
      const file=await this.source(id);
      this.sourceTables.set(id,file && ['csv','tsv'].includes(file.kind)?parseTable(file):null);
    }
    return this.sourceTables.get(id);
  }
  async verify(trial,field,sourceId,rule) {
    if(!trial.links.includes(sourceId) || !this.visible(sourceId))return;
    const cell=trial.cells.find(c=>c.label===field);
    if(!cell || !numerals.test(cell.value))return;
    const table=await this.csv(sourceId),locator=measure(table,rule,cell.value);
    if(!locator)return;
    const ref=this.ref(sourceId,locator,field+' = '+cell.value+' · '+rule.statistic+'('+rule.column+')',table.revision);
    if(ref){cell.ref=ref;cell.verified=true;this.readRefs.add(ref);}
    return ref;
  }
  async trialTable(id,record) {
    if(this.tables.has(id))return this.tables.get(id);
    const rules=(this.snapshot.project.search?.measurements||[]).filter(r=>(!r.recordId||r.recordId===id)&&(!r.recordType||r.recordType===record.record.type));
    const rows=[];
    for(const tr of trialRows(record.body).filter(r=>this.date(r.locator.date)).slice(0,35)){
      this.signal?.throwIfAborted();
      const ref=this.ref(id,tr.locator,tr.values.join(' | '),record.revision);if(!ref)break;
      this.readRefs.add(ref);
      const links=tr.links.filter(link=>this.visible(link));
      const cells=tr.columns.flatMap((label,i)=> i<2 || /(?:原始证据|evidence|sources?)/i.test(label) ? [] : [{label:clip(label,100),value:clip(tr.values[i],200),ref}]);
      const row={trialId:tr.locator.trialId,date:tr.locator.date,ref,cells,links};
      for(const rule of rules){
        for(const link of links.filter(k=>/\.(csv|tsv)$/i.test(this.docs.get(k).relativePath))){
          try{if(await this.verify(row,rule.field,link,rule))break;}catch{ /* The recorded value still has its original trial citation. */ }
        }
      }
      rows.push(row);
    }
    const table={id,title:this.docs.get(id).title,rows};this.tables.set(id,table);return table;
  }
  links(ids) {return [...new Set(ids)].flatMap(id=>{const ref=this.ref(id);return ref?[this.card(ref)]:[];}).slice(0,18);}
  async read(ref) {
    const c=this.citations[ref];if(!c || !this.visible(c.id))throw Error('Unknown or out-of-scope evidence.');
    this.signal?.throwIfAborted();
    let passages,revision,table,related=[];
    if(this.records.has(c.id)){
      const rec=await this.store.read(c.id);revision=rec.revision;passages=markdownPassages(rec.body);
      table=await this.trialTable(c.id,rec);
      related=this.links([...(rec.record.evidence||[]),...(rec.record.sources||[])]);
    }else{
      const doc=this.docs.get(c.id);
      if(doc.sourceId){
        const file=await this.source(c.id);
        if(['csv','tsv'].includes(file.kind)){
          const data=await this.csv(c.id); if(!data)throw Error('Table exceeds the preview limit.');
          this.readRefs.add(ref);return {ref,columns:data.header.slice(0,48).map(s=>clip(s,100)),sample:data.rows.slice(0,5).map(row=>row.slice(0,48).map(v=>clip(v,90))),rows:data.rows.length};
        }
        if(file.bytes){revision=digest(file.bytes);passages=await reportPassages(file.kind,Buffer.from(file.bytes));}
        else if(file.kind==='text'){revision=digest(Buffer.from(file.content));passages=markdownPassages(file.content);}
        else return {ref,title:clip(c.title),status:'only the title is available'};
      }else{
        const file=await this.store.indexedDocument(c.id,doc.relativePath);
        const {bytes}=await readBytes(path.join(this.store.root,file.relativePath),MAX_DOCUMENT_BYTES);
        revision=digest(bytes);passages=markdownPassages(decodeDocument(bytes).content);
      }
    }
    // Trial dates are real activity dates, even when the document has an older creation date.
    passages=passages.filter(p=>!p.locator.date || this.date(p.locator.date));
    const target=passages.findIndex(p=>sameLocator(p.locator,c.locator));
    const positions=new Set([0,...(target>=0?[target-1,target,target+1]:[1,2])]);
    const context=[];
    for(const i of positions) {
      const p=passages[i];if(!p)continue;const key=this.ref(c.id,p.locator,p.text,revision);
      if(key){this.readRefs.add(key);context.push(this.card(key));}
    }
    return {ref,title:clip(c.title),context,...(table?.rows.length && {trials:table.rows.map(row=>({trial:row.trialId,date:row.date,ref:row.ref,cells:row.cells,links:this.links(row.links)}))}),related};
  }
  follow(ref) {
    const c=this.citations[ref];if(!c || !this.visible(c.id))throw Error('Unknown or out-of-scope evidence.');
    const rec=this.records.get(c.id)?.record;
    const relations=(rec?.relations || []).map(r=>({id:r.target,kind:r.kind}));
    for(const e of this.snapshot.records){
      for(const r of e.record.relations||[])if(r.target===c.id)relations.push({id:e.record.id,kind:r.kind});
    }
    for(const id of [...rec?.sources||[],...rec?.evidence||[],...rec?.run?.evidence||[]])relations.push({id,kind:'source'});
    return relations.flatMap(r=>{const key=this.ref(r.id);return key?[{kind:r.kind,...this.card(key)}]:[];}).slice(0,24);
  }
  async measured(args) {
    const t=this.citations[args.trial],s=this.citations[args.source];
    if(!t || !s || t.locator.kind!=='trial' || !Array.isArray(args.filters) || args.filters.length>12)throw Error('Invalid measurement request.');
    const row=this.tables.get(t.id)?.rows.find(r=>r.ref===args.trial);
    const filters=Object.fromEntries(args.filters.map(f=>[String(f.column),String(f.value)]));
    const ref=row && await this.verify(row,args.field,s.id,{column:args.column,where:filters,statistic:args.statistic});
    return ref?this.card(ref):{status:'No verified match for the recorded number and group.'};
  }
  outputTables(ids) {
    return [...this.tables.values()].filter(t=>t.rows.length && ids.has(t.id)).map(t=>({title:t.title,rows:t.rows.map(({links,...row})=>row)}));
  }
}
module.exports={Evidence,safeText};
