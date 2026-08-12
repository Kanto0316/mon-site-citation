#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATION_ORDER = [
  'users','sites','outs','out_articles','historiques','messages','message_recipients',
  'achats','material_requests','material_request_items','out_deletion_limits',
  'site_unlock_protections','app_settings',
];

const FIELD_MAP = {
  users: { uid:'uid', username:'username', displayName:'display_name', name:'name', email:'email', photoURL:'photo_url', avatarUrl:'avatar_url', avatar:'avatar', role:'role', status:'status', approved:'approved', pending:'pending', maintenanceAuthorized:'maintenance_authorized', maintenanceAccess:'maintenance_access', readMessages:'read_messages', createdAt:'created_at', updatedAt:'updated_at', lastLoginAt:'last_login_at', lastActivity:'last_activity_at', lastSeenAt:'last_seen_at', lastNameChange:'last_name_change_at', presence:'presence', online:'online' },
  sites: { nom:'nom', ownerId:'owner_firebase_id', createdBy:'created_by_firebase_id', createdByName:'created_by_name', dateCreation:'created_at', dateModification:'updated_at', passwordHash:'password_hash', locked:'locked', unlockedBy:'unlocked_by', unlockedByName:'unlocked_by_name', unlockAttemptsRemaining:'unlock_attempts_remaining', unlockBlockedUntil:'unlock_blocked_until', unlockProtections:'unlock_protections', inactiveSince:'inactive_since', inactivityDecisionPending:'inactivity_decision_pending', inactivityDecisionPendingAt:'inactivity_decision_pending_at', inactivityRestoredAt:'inactivity_restored_at' },
  outs: { siteId:'site_firebase_id', numero:'numero', magasin:'magasin', ownerId:'owner_firebase_id', createdBy:'created_by_firebase_id', createdByName:'created_by_name', dateCreation:'created_at', dateModification:'updated_at' },
  out_articles: { siteId:'site_firebase_id', itemId:'item_firebase_id', champ:'champ', code:'code', designation:'designation', qteSortie:'qte_sortie', unite:'unite', qteHorsBtrs:'qte_hors_btrs', qteRetour:'qte_retour', dateRetour:'date_retour', qtePosee:'qte_posee', qteRebus:'qte_rebus', observation:'observation', statut:'statut', ownerId:'owner_firebase_id', createdBy:'created_by_firebase_id', dateCreation:'created_at', dateModification:'updated_at' },
  historiques: { userId:'user_firebase_id', userName:'user_name', action:'action', siteId:'site_firebase_id', siteName:'site_name', createdAt:'created_at' },
  messages: { title:'title', body:'body', status:'status', createdBy:'created_by_firebase_id', createdAt:'created_at', updatedAt:'updated_at' },
  achats: { designation:'designation', quantite:'quantite', magasin:'magasin', remark:'remark', photoUrl:'photo_url', photoURL:'photo_url', photoProvider:'photo_provider', photoMetadata:'photo_metadata', createdBy:'created_by_firebase_id', createdByName:'created_by_name', createdByEmail:'created_by_email', createdAt:'created_at', updatedAt:'updated_at' },
  material_requests: { requestTitle:'request_title', requesterId:'requester_firebase_id', userId:'requester_firebase_id', siteId:'site_firebase_id', statut:'statut', status:'statut', remark:'remark', createdAt:'created_at', updatedAt:'updated_at', items:'items' },
  out_deletion_limits: { date:'date_key', count:'count', updatedAt:'updated_at' },
  message_recipients: { messageId:'message_firebase_id', recipientId:'recipient_firebase_id', recipientName:'recipient_name', recipientEmail:'recipient_email', readAt:'read_at', createdAt:'created_at' },
  app_settings: { enabled:'enabled', updatedBy:'updated_by_firebase_id', updatedAt:'updated_at' },
};
const DATE_FIELDS = new Set(['createdAt','updatedAt','dateCreation','dateModification','lastLoginAt','lastActivity','lastSeenAt','lastNameChange','inactiveSince','inactivityDecisionPendingAt','inactivityRestoredAt','created_at','updated_at','dateRetour','blockedUntil','unlockBlockedUntil','updatedAt']);
const SENSITIVE = /(password(?!Hash)|motdepasse|secret|token|credential|api[_-]?key|private[_-]?key|session|refreshToken|accessToken)/i;
const REQUIRED_FIELDS = { users:['email'], sites:['nom'], outs:['siteId','numero'], out_articles:['itemId','designation'], historiques:['action'], messages:['title','body'], achats:['designation'], material_requests:['requestTitle'] };
const DUPLICATE_KEYS = { sites:[['nom']], outs:[['siteId','numero']], out_articles:[['siteId','itemId','designation','code']] };


function usage(msg) { if (msg) console.error(`Erreur: ${msg}`); console.error('Usage: node migration/firebase-to-supabase.js <export.su> [--dry-run] [--verbose] [--output <path>]'); process.exit(msg ? 1 : 0); }
function parseArgs(argv) { const args={dryRun:true,verbose:false,output:null,source:null}; for(let i=2;i<argv.length;i++){ const a=argv[i]; if(a==='--dry-run') args.dryRun=true; else if(a==='--verbose') args.verbose=true; else if(a==='--execute') usage('--execute est désactivé pour cette étape: DRY-RUN uniquement, 0 écriture.'); else if(a==='--output') args.output=argv[++i]||usage('--output requiert un chemin'); else if(a.startsWith('--')) usage(`option inconnue ${a}`); else if(!args.source) args.source=a; else usage(`argument inattendu ${a}`);} if(!args.source) usage('fichier export .su requis'); return args; }
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT_DIRECTORY = path.join(REPOSITORY_ROOT, 'migration', 'reports');
function resolveFromRepository(inputPath){ return path.isAbsolute(inputPath) ? inputPath : path.resolve(REPOSITORY_ROOT, inputPath); }
function displayFromRepository(inputPath){ const relative=path.relative(REPOSITORY_ROOT,inputPath); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : inputPath; }
function readSchema(){ const p=path.join(REPOSITORY_ROOT,'supabase','schema.sql'); return fs.existsSync(p)?fs.readFileSync(p,'utf8'):''; }
function parseExport(file){ const raw=fs.readFileSync(file,'utf8'); const trimmed=raw.replace(/^\uFEFF/,'').trim(); const attempts=[()=>JSON.parse(trimmed),()=>JSON.parse(trimmed.replace(/^export\s+default\s+/,'').replace(/;$/,''))]; for(const fn of attempts){ try{return fn();}catch{} } const lines=trimmed.split(/\r?\n/).filter(Boolean); const docs=[]; let ok=0; for(const line of lines){ try{docs.push(JSON.parse(line)); ok++;}catch{} } if(ok && ok===lines.length) return docs; throw new Error('Format .su non reconnu: JSON objet/tableau ou JSONL attendu. Parser à adapter après inspection de la structure réelle.'); }
function stableUuid(ns, id){ return crypto.createHash('sha1').update(`${ns}:${id}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/,'$1-$2-4$3-a$4-$5'); }
function doc(id,data,pathParts){ const parts=Array.isArray(pathParts)?pathParts:String(pathParts||'').split('/').filter(Boolean); return { firebase_id:String(id), path:parts, data:data&&typeof data==='object'?data:{value:data}, target:null, mapped:{firebase_id:String(id)}, unmapped:[]};}
function walkFirestore(node, parts=[], out=[]){
  if(!node||typeof node!=='object') return out;
  if(node.fields || node.__collections__){ out.push(doc(parts.at(-1)||node.name||`doc_${out.length}`, unwrap(node.fields||node), parts)); return out; }
  const keys=Object.keys(node);
  if(parts.length > 0 && parts.length % 2 === 0){
    const data={};
    for(const [k,v] of Object.entries(node)){
      const looksLikeSubcollection = v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(child => child && typeof child === 'object');
      if(looksLikeSubcollection && (k==='items' || k==='achatsMateriels' || k==='outDeletionLimits')) walkFirestore(v, parts.concat(k), out);
      else data[k]=v;
    }
    if(Object.keys(data).length) out.push(doc(parts.at(-1)||`doc_${out.length}`, unwrap(data), parts));
    return out;
  }
  for(const key of keys) walkFirestore(node[key], parts.concat(key), out);
  return out;
}
function unwrap(v){ if(!v||typeof v!=='object') return v; if('stringValue'in v) return v.stringValue; if('integerValue'in v) return Number(v.integerValue); if('doubleValue'in v) return Number(v.doubleValue); if('booleanValue'in v) return v.booleanValue; if('timestampValue'in v) return v.timestampValue; if('nullValue'in v) return null; if('mapValue'in v) return unwrap(v.mapValue.fields||{}); if('arrayValue'in v) return Object.values(v.arrayValue.values||[]).map(unwrap); const o=Array.isArray(v)?[]:{}; for(const [k,val] of Object.entries(v)) o[k]=unwrap(val); return o; }
function extractDocs(root){ if(Array.isArray(root)) return root.map((x,i)=>doc(x.id||x.name||x.path||`row_${i}`, x.data||x.fields||x, String(x.path||'').split('/').filter(Boolean))); return walkFirestore(root); }
function classify(d){ const p=d.path; if(p.join('/')==='appSettings/maintenance'||p[0]==='appSettings') return 'app_settings'; if(p[0]==='users'&&p[2]==='outDeletionLimits') return 'out_deletion_limits'; if(p[0]==='users'&&p.length===2) return 'users'; if(p.join('/').startsWith('pages/page1/items/')) return 'sites'; if(p.join('/').startsWith('pages/page2/items/')) return 'outs'; if(p.join('/').startsWith('pages/page3/items/')) return 'out_articles'; if(p[0]==='historiques') return 'historiques'; if(p[0]==='adminMessages') return 'messages'; if(p[0]==='sites'&&p[2]==='achatsMateriels') return 'achats'; if(p[0]==='materialRequests') return 'material_requests'; return null; }
function normalizeDate(value){ if(value==null||value==='') return {value:null,kind:'null'}; if(value instanceof Date) return {value:value.toISOString(),kind:'date'}; if(typeof value==='string'){ const d=new Date(value); return Number.isNaN(d.getTime())?{value:null,kind:'invalid'}:{value:d.toISOString(),kind:'iso'}; } if(typeof value==='number'){ const d=new Date(value > 1e12 ? value : value*1000); return Number.isNaN(d.getTime())?{value:null,kind:'invalid'}:{value:d.toISOString(),kind:'number'}; } if(typeof value==='object'){ const s=value.seconds ?? value._seconds; const ns=value.nanoseconds ?? value._nanoseconds ?? 0; if(Number.isFinite(Number(s))) return {value:new Date(Number(s)*1000+Math.floor(Number(ns)/1e6)).toISOString(),kind:'firestore'}; } return {value:null,kind:'invalid'}; }
function addIssue(report, section, issue){ report[section].push(issue); }
function main(){ const args=parseArgs(process.argv); const sourcePath=resolveFromRepository(args.source); const outputDirectory=args.output ? resolveFromRepository(args.output) : DEFAULT_REPORT_DIRECTORY; const jsonReportPath=path.join(outputDirectory,'dry-run-report.json'); const textReportPath=path.join(outputDirectory,'dry-run-report.txt'); const before=fs.statSync(sourcePath).mtimeMs; readSchema(); const docs=extractDocs(parseExport(sourcePath)); const report={mode:'DRY_RUN',source:sourcePath,generatedAt:new Date().toISOString(),summary:{users:0,sites:0,outs:0,articles:0,historiques:0,messages:0,achats:0},relations:{valid:0,invalid:0,orphans:0},anomalies:{duplicates:0,ownerMismatch:0,invalidDates:0,missingFields:0,unmappedFields:0},details:{orphans:[],duplicates:[],ownerMismatches:[],invalidDates:[],missingFields:[],unmappedFields:[]},writesPerformed:false,generated_at:null,relation_checks:{valid:0,invalid:0,missing:0,details:[]},orphan_data:[],duplicates:[],owner_mismatch:[],invalid_dates:[],missing_required_fields:[],invalid_types:[],unmapped_fields:[],sensitive_fields_detected:[],migration_estimate:{},safety:{supabase_writes:0, firebase_writes:0, source_writes:0, dry_run_only:true}}; report.generated_at=report.generatedAt;
 const entities=Object.fromEntries(MIGRATION_ORDER.map(k=>[k,[]]));
 for(const d of docs){ const t=classify(d); if(!t){ addIssue(report,'unmapped_fields',{type:'UNMAPPED_COLLECTION',firebase_id:d.firebase_id,path:d.path}); continue;} d.target=t; entities[t].push(d); if(t==='messages' && (d.data.recipientId||d.data.recipientEmail||d.data.recipientName)){ { const rd=doc(`${d.firebase_id}:recipient`, {messageId:d.firebase_id, recipientId:d.data.recipientId, recipientName:d.data.recipientName, recipientEmail:d.data.recipientEmail, createdAt:d.data.createdAt}, d.path.concat('_recipient')); rd.target='message_recipients'; entities.message_recipients.push(rd); } }}
 const ids={users:new Map(),sites:new Map(),outs:new Map(),out_articles:new Map(),messages:new Map(),material_requests:new Map()}; for(const k of Object.keys(ids)) for(const e of entities[k]) ids[k].set(e.firebase_id, stableUuid(k,e.firebase_id));
 function mapFields(e){ const fm=FIELD_MAP[e.target]||{}; for(const [k,v] of Object.entries(e.data)){ if(e.target==='messages' && /^recipient/.test(k)) continue; if(SENSITIVE.test(k)){ addIssue(report,'sensitive_fields_detected',{type:'SENSITIVE_FIELD_DETECTED',entity:e.target,firebase_id:e.firebase_id,field:k}); continue;} if(DATE_FIELDS.has(k)){ const n=normalizeDate(v); if(n.kind==='invalid') addIssue(report,'invalid_dates',{entity:e.target,firebase_id:e.firebase_id,field:k}); e.mapped[fm[k]||k]=n.value; continue;} if(fm[k]) e.mapped[fm[k]]=v; else addIssue(report,'unmapped_fields',{type:'UNMAPPED',entity:e.target,firebase_id:e.firebase_id,field:k}); }}
 for(const k of MIGRATION_ORDER) entities[k].forEach(mapFields);
 function ref(entity, fid, target, field, parent){ if(!fid){ report.relation_checks.missing++; return;} if(ids[target].has(String(fid))) report.relation_checks.valid++; else { report.relation_checks.invalid++; addIssue(report,'orphan_data',{type:'ORPHAN_DATA',entity,firebase_id:parent.firebase_id,field,reference_value:String(fid),expected_parent:target,reason:'Référence Firebase introuvable dans l’export'}); }}
 for(const s of entities.sites){ ref('sites',s.data.ownerId,'users','ownerId',s); if(s.data.createdBy) ref('sites',s.data.createdBy,'users','createdBy',s); if(s.data.ownerId&&s.data.createdBy&&s.data.ownerId!==s.data.createdBy) addIssue(report,'owner_mismatch',{type:'OWNER_MISMATCH',entity:'sites',firebase_id:s.firebase_id,ownerId:s.data.ownerId,createdBy:s.data.createdBy}); }
 for(const o of entities.outs){ ref('outs',o.data.siteId,'sites','siteId',o); ref('outs',o.data.ownerId||o.data.createdBy,'users','ownerId/createdBy',o); }
 for(const a of entities.out_articles){ ref('out_articles',a.data.siteId,'sites','siteId',a); ref('out_articles',a.data.itemId,'outs','itemId',a); if(a.data.ownerId||a.data.createdBy) ref('out_articles',a.data.ownerId||a.data.createdBy,'users','ownerId/createdBy',a); }
 for(const h of entities.historiques){ if(h.data.userId) ref('historiques',h.data.userId,'users','userId',h); if(h.data.siteId) ref('historiques',h.data.siteId,'sites','siteId',h); }
 for(const m of entities.message_recipients) if(m.data.recipientId) ref('message_recipients',m.data.recipientId,'users','recipientId',m);
 for(const a of entities.achats){ const sid=a.path[1]||a.data.siteId; a.mapped.site_firebase_id=sid; ref('achats',sid,'sites','siteId(path)',a); if(a.data.createdBy) ref('achats',a.data.createdBy,'users','createdBy',a); }
 for(const r of entities.material_requests){ if(r.data.requesterId||r.data.userId) ref('material_requests',r.data.requesterId||r.data.userId,'users','requesterId/userId',r); if(r.data.siteId) ref('material_requests',r.data.siteId,'sites','siteId',r); (Array.isArray(r.data.items)?r.data.items:[]).forEach((it,i)=>entities.material_request_items.push(doc(`${r.firebase_id}:item:${i}`,{...it,requestId:r.firebase_id,position:i},r.path.concat('items',String(i))))); }
 for(const k of MIGRATION_ORDER){ const seen=new Set(); for(const e of entities[k]){ if(seen.has(e.firebase_id)) addIssue(report,'duplicates',{type:'DUPLICATE_CANDIDATE',entity:k,firebase_id:e.firebase_id,reason:'ID Firebase dupliqué'}); seen.add(e.firebase_id); for(const f of (REQUIRED_FIELDS[k]||[])){ if(e.data[f] === undefined || e.data[f] === null || e.data[f] === '') addIssue(report,'missing_required_fields',{type:'MISSING_REQUIRED_FIELD',entity:k,firebase_id:e.firebase_id,field:f}); } } }
 for(const [entity, keySets] of Object.entries(DUPLICATE_KEYS)){ for(const fields of keySets){ const seenKey=new Map(); for(const e of entities[entity]){ const key=fields.map(f=>String(e.data[f]??'').trim().toLowerCase()).join('||'); if(key.replace(/\|/g,'')){ if(seenKey.has(key)) addIssue(report,'duplicates',{type:'DUPLICATE_CANDIDATE',entity,firebase_id:e.firebase_id,fields,reason:`Même clé métier que ${seenKey.get(key)}`}); else seenKey.set(key,e.firebase_id); } } } }
 const emailSeen=new Map(); for(const u of entities.users){ const email=String(u.data.email||'').toLowerCase(); if(email){ if(emailSeen.has(email)) addIssue(report,'duplicates',{type:'DUPLICATE_CANDIDATE',entity:'users',firebase_id:u.firebase_id,field:'email',reason:`Email déjà présent sur ${emailSeen.get(email)}`}); else emailSeen.set(email,u.firebase_id);} }
 for(const [k,list] of Object.entries(entities)){ if(k==='out_articles') report.summary.articles=list.length; else if(Object.prototype.hasOwnProperty.call(report.summary,k)) report.summary[k]=list.length; const errors=[...report.orphan_data,...report.missing_required_fields,...report.invalid_types].filter(x=>x.entity===k).length; report.migration_estimate[k]={total:list.length,ready:Math.max(0,list.length-errors),errors}; }
 report.relations.valid=report.relation_checks.valid; report.relations.invalid=report.relation_checks.invalid; report.relations.orphans=report.orphan_data.length;
 report.anomalies.duplicates=report.duplicates.length; report.anomalies.ownerMismatch=report.owner_mismatch.length; report.anomalies.invalidDates=report.invalid_dates.length; report.anomalies.missingFields=report.missing_required_fields.length; report.anomalies.unmappedFields=report.unmapped_fields.length;
 report.details.orphans=report.orphan_data; report.details.duplicates=report.duplicates; report.details.ownerMismatches=report.owner_mismatch; report.details.invalidDates=report.invalid_dates; report.details.missingFields=report.missing_required_fields; report.details.unmappedFields=report.unmapped_fields;
 fs.mkdirSync(outputDirectory,{recursive:true}); fs.writeFileSync(jsonReportPath,JSON.stringify(report,null,2)); fs.writeFileSync(textReportPath,renderText(report));
 const writtenJson=fs.existsSync(jsonReportPath) && fs.statSync(jsonReportPath).size > 0; const writtenTxt=fs.existsSync(textReportPath) && fs.statSync(textReportPath).size > 0; if(!writtenJson || !writtenTxt) throw new Error(`Échec de génération des rapports: JSON=${writtenJson}, TXT=${writtenTxt}`);
 if(fs.statSync(sourcePath).mtimeMs!==before) throw new Error('Protection dry-run: le fichier source a été modifié.'); printConsole(report,{...args,source:sourcePath,outputDirectory,jsonReportPath,textReportPath}); }
function renderText(r){ return `========================================
 FIREBASE → SUPABASE DRY-RUN
========================================

Source :
${path.basename(r.source)}

Date :
${r.generatedAt}

----------------------------------------
 DONNÉES
----------------------------------------

Users       : ${r.summary.users}
Sites       : ${r.summary.sites}
OUT         : ${r.summary.outs}
Articles    : ${r.summary.articles}
Historique  : ${r.summary.historiques}
Messages    : ${r.summary.messages}
Achats      : ${r.summary.achats}

----------------------------------------
 RELATIONS
----------------------------------------

Relations valides     : ${r.relations.valid}
Relations invalides   : ${r.relations.invalid}
Données orphelines    : ${r.relations.orphans}

----------------------------------------
 ANOMALIES
----------------------------------------

Doublons potentiels   : ${r.anomalies.duplicates}
Owner mismatch        : ${r.anomalies.ownerMismatch}
Dates invalides       : ${r.anomalies.invalidDates}
Champs manquants      : ${r.anomalies.missingFields}
Champs non mappés     : ${r.anomalies.unmappedFields}

----------------------------------------
 SÉCURITÉ
----------------------------------------

Écriture Supabase : NON

Modification Firebase : NON

Modification du fichier source : NON

----------------------------------------
 DÉTAILS JSON INCLUS DANS dry-run-report.json
----------------------------------------

Orphelins              : ${r.details.orphans.length}
Doublons               : ${r.details.duplicates.length}
Owner mismatches       : ${r.details.ownerMismatches.length}
Dates invalides        : ${r.details.invalidDates.length}
Champs manquants       : ${r.details.missingFields.length}
Champs non mappés      : ${r.details.unmappedFields.length}
Champs sensibles       : ${r.sensitive_fields_detected.length}

----------------------------------------
 FIN DU DRY-RUN
----------------------------------------

0 écriture effectuée dans Supabase.
`; }
function printConsole(r,args){ const anomalies=r.duplicates.length+r.owner_mismatch.length+r.invalid_dates.length+r.missing_required_fields.length+r.unmapped_fields.length; const jsonDisplay=displayFromRepository(args.jsonReportPath); const textDisplay=displayFromRepository(args.textReportPath); console.log(`========================================
 DRY-RUN TERMINÉ
========================================

Aucune donnée n'a été écrite dans Supabase.

Rapport JSON :
${jsonDisplay}

Rapport TXT :
${textDisplay}

========================================`); if(args.verbose && anomalies) console.log(JSON.stringify({orphan_data:r.orphan_data,duplicates:r.duplicates,owner_mismatch:r.owner_mismatch,invalid_dates:r.invalid_dates,unmapped_fields:r.unmapped_fields,sensitive_fields_detected:r.sensitive_fields_detected},null,2)); }
try { main(); } catch (error) { console.error(`Erreur génération dry-run: ${error.message}`); process.exit(1); }
