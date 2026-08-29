#!/usr/bin/env node
'use strict';

/** Read-only, paginated Firestore REST export for the Supabase migration. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 'firebase-supabase-migration-export';
const VERSION = 1;
const PAGE_SIZE = 300;
const FORBIDDEN_SOURCE_OPERATIONS = /\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction|commit|batchWrite)\b/;
const REQUIRED = Object.freeze([
  'users', 'appSettings', 'page1', 'page2', 'page3', 'materialCodes',
  'historiques', 'trash', 'purchasesBySite', 'materialRequests',
  'adminMessages', 'outDeletionLimitsByUser',
]);
const SENSITIVE_FIELDS = /^(?:password|loginMemo|token|refreshToken|privateKey|serviceAccount|service_role)$/i;

function usage(message) {
  const text = 'Usage: node migration/export-firebase-data.js --project-id <id> [--output <local.json>] [--self-test]\n' +
    'Auth locale: FIREBASE_ACCESS_TOKEN (jeton OAuth court) ou GOOGLE_APPLICATION_CREDENTIALS via gcloud auth application-default print-access-token.';
  (message ? console.error : console.log)(message ? `Erreur: ${message}\n${text}` : text);
  process.exit(message ? 1 : 0);
}

function argsOf(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--help') usage();
    else if (arg === '--project-id' || arg === '--output') {
      if (!argv[i + 1]) usage(`${arg} requiert une valeur`);
      out[arg === '--project-id' ? 'projectId' : 'output'] = argv[++i];
    } else usage(`option inconnue: ${arg}`);
  }
  if (!out.selfTest && !out.projectId) usage('--project-id est requis');
  out.output ||= path.join('migration', 'exports', `firebase-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  return out;
}

function assertReadOnly() {
  const ownSource = fs.readFileSync(__filename, 'utf8');
  const executable = ownSource.replace(/const FORBIDDEN_SOURCE_OPERATIONS[^;]+;/, '').replace(/function assertReadOnly\(\)[\s\S]*?\n}/, '');
  if (FORBIDDEN_SOURCE_OPERATIONS.test(executable)) throw new Error('READ_ONLY_GUARD: une primitive d’écriture a été introduite.');
}

function timestamp(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw new Error(`Timestamp Firestore invalide: ${value}`);
  const milliseconds = Date.parse(`${match[1]}Z`);
  return { __type: 'firestore_timestamp', seconds: Math.floor(milliseconds / 1000), nanoseconds: Number((match[2] || '').padEnd(9, '0')) };
}

function decode(value) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return timestamp(value.timestampValue);
  if ('integerValue' in value) {
    const number = Number(value.integerValue);
    return Number.isSafeInteger(number) ? number : { __type: 'firestore_integer', value: value.integerValue };
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('bytesValue' in value) return { __type: 'firestore_bytes', base64: value.bytesValue };
  if ('referenceValue' in value) return { __type: 'firestore_reference', value: value.referenceValue };
  if ('geoPointValue' in value) return { __type: 'firestore_geopoint', latitude: value.geoPointValue.latitude, longitude: value.geoPointValue.longitude };
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  throw new Error(`Type Firestore non pris en charge: ${Object.keys(value).join(',')}`);
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (SENSITIVE_FIELDS.test(key)) throw new Error(`SENSITIVE_FIELD_REFUSED: ${key}`);
    return [key, decode(value)];
  }));
}

function documentId(name) { return decodeURIComponent(name.slice(name.lastIndexOf('/') + 1)); }

async function accessToken() {
  if (process.env.FIREBASE_ACCESS_TOKEN) return process.env.FIREBASE_ACCESS_TOKEN;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Aucun accès local: FIREBASE_ACCESS_TOKEN ou GOOGLE_APPLICATION_CREDENTIALS requis.');
  const { execFileSync } = require('node:child_process');
  return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function listCollection(projectId, token, collectionPath) {
  const slash = collectionPath.lastIndexOf('/');
  const parent = slash < 0 ? '' : `/${collectionPath.slice(0, slash)}`;
  const collectionId = slash < 0 ? collectionPath : collectionPath.slice(slash + 1);
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents${parent}/${encodeURIComponent(collectionId)}`;
  const documents = {};
  let pageToken;
  do {
    const url = new URL(base);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('orderBy', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { const error = new Error(`Firestore HTTP ${response.status} pendant la lecture de ${collectionPath}`); error.status = response.status; throw error; }
    const body = await response.json();
    for (const doc of body.documents || []) documents[documentId(doc.name)] = decodeFields(doc.fields || {});
    pageToken = body.nextPageToken;
  } while (pageToken);
  return documents;
}

function inventoryEntry(collection, documents, subcollectionsCount = 0) {
  return { collection, documents_count: Object.keys(documents).length, subcollections_count: subcollectionsCount, export_status: Object.keys(documents).length ? 'EXPORTED' : 'EMPTY' };
}

async function safeRead(projectId, token, name, collectionPath, inventory) {
  try { const docs = await listCollection(projectId, token, collectionPath); inventory[name] = inventoryEntry(collectionPath, docs); return docs; }
  catch (error) { inventory[name] = { collection: collectionPath, documents_count: null, subcollections_count: null, export_status: error.status === 401 || error.status === 403 ? 'NOT_ACCESSIBLE' : 'FAILED' }; throw error; }
}

async function buildExport(projectId, token) {
  const inventory = {};
  const collections = {};
  for (const name of ['users', 'appSettings', 'materialCodes', 'historiques', 'trash', 'materialRequests', 'adminMessages']) collections[name] = await safeRead(projectId, token, name, name, inventory);
  for (const page of ['page1', 'page2', 'page3']) collections[page] = await safeRead(projectId, token, page, `pages/${page}/items`, inventory);
  const siteParents = await safeRead(projectId, token, '_sites_parents', 'sites', inventory);
  collections.purchasesBySite = {};
  let purchaseCount = 0;
  for (const siteId of Object.keys(siteParents)) { const docs = await listCollection(projectId, token, `sites/${siteId}/achatsMateriels`); collections.purchasesBySite[siteId] = docs; purchaseCount += Object.keys(docs).length; }
  inventory.purchasesBySite = { collection: 'sites/{siteId}/achatsMateriels', documents_count: purchaseCount, subcollections_count: Object.keys(siteParents).length, export_status: purchaseCount ? 'EXPORTED' : 'EMPTY' };
  collections.outDeletionLimitsByUser = {};
  let limitCount = 0;
  for (const uid of Object.keys(collections.users)) { const docs = await listCollection(projectId, token, `users/${uid}/outDeletionLimits`); collections.outDeletionLimitsByUser[uid] = docs; limitCount += Object.keys(docs).length; }
  inventory.outDeletionLimitsByUser = { collection: 'users/{uid}/outDeletionLimits', documents_count: limitCount, subcollections_count: Object.keys(collections.users).length, export_status: limitCount ? 'EXPORTED' : 'EMPTY' };
  delete inventory._sites_parents;
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), firebaseAuthExportRequired: true, manifest: { FIREBASE_AUTH_EXPORT_REQUIRED: 'YES', read_only: true, inventory }, collections };
}

function writeExport(output, data) {
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${target}.sha256`, `${hash}  ${path.basename(target)}\n`, { mode: 0o600, flag: 'wx' });
  return { target, hash };
}

function selfTest() {
  assertReadOnly();
  const decoded = decodeFields({ zero:{integerValue:'0'}, no:{booleanValue:false}, empty:{stringValue:''}, nil:{nullValue:null}, when:{timestampValue:'2026-01-02T03:04:05.123456789Z'}, list:{arrayValue:{values:[]}} });
  if (decoded.zero !== 0 || decoded.no !== false || decoded.empty !== '' || decoded.nil !== null || decoded.when.nanoseconds !== 123456789 || !Array.isArray(decoded.list)) throw new Error('Test de sérialisation lossless échoué.');
  try { decodeFields({ password:{stringValue:'x'} }); throw new Error('Le filtre secret a échoué.'); } catch (error) { if (!String(error.message).startsWith('SENSITIVE_FIELD_REFUSED')) throw error; }
  console.log('EXPORT_SELF_TESTS = PASSED\nREAD_ONLY = YES\nFIREBASE_AUTH_EXPORT_REQUIRED = YES');
}

async function main() {
  const args = argsOf(process.argv);
  assertReadOnly();
  if (args.selfTest) return selfTest();
  const token = await accessToken();
  const data = await buildExport(args.projectId, token);
  for (const name of REQUIRED) if (!data.manifest.inventory[name] || ['FAILED', 'NOT_ACCESSIBLE'].includes(data.manifest.inventory[name].export_status)) throw new Error(`EXPORT_INCOMPLETE: ${name}`);
  const result = writeExport(args.output, data);
  console.log(`export_file = ${result.target}\nsource_sha256 = ${result.hash}\nREAD_ONLY = YES\nFIREBASE_AUTH_EXPORT_REQUIRED = YES`);
}

main().catch(error => { console.error(`EXPORT_ERROR: ${error.message}`); process.exitCode = 1; });
