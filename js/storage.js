import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  arrayUnion,
  onSnapshot,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseAuth, firebaseDb } from './firebase-core.js';
import { APP_CONFIG } from './config.js';
import { getAutomaticUnit } from './automatic-unit.js';
import { isReturnQuantityWithinAvailable, roundReturnQuantity, sumReturnQuantities } from './return-quantity.js';

const OFFLINE_CACHE_KEY = 'suiviMateriel.offlineCache.v1';
const OFFLINE_CACHE_TTL_MS = 180 * 1000;
const SITE_INACTIVITY_THRESHOLD_DAYS = Number(APP_CONFIG?.siteInactivity?.thresholdDays) || 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const state = {
  initialized: false,
  db: null,
  userId: null,
  authUser: null,
  sites: [],
  itemsBySite: new Map(),
  detailsByItem: new Map(),
  materialCodes: [],
  loadedItemSites: new Set(),
  loadedDetailSites: new Set(),
  loadedDetailPairs: new Set(),
  listeners: {
    sites: new Set(),
    itemCounts: new Set(),
    itemsBySite: new Map(),
    detailCountsBySite: new Map(),
    detailDesignationsBySite: new Map(),
    detailRowsBySite: new Map(),
    detailsByPair: new Map(),
  },
};

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') {
    return 'admin';
  }
  if (role === 'adjoint' || role === 'adjoint admin' || role === 'full' || role === 'standard') {
    return 'standard';
  }
  if (role === 'lecture') {
    return 'lecture';
  }
  if (role === 'ecriture' || role === 'écriture' || role === 'limite' || role === 'limité') {
    return 'limite';
  }
  return 'limite';
}

function serializeRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === 'admin') {
    return 'admin';
  }
  if (normalized === 'standard') {
    return 'Adjoint Admin';
  }
  return 'Limité';
}

function normalizeUsername(value) {
  return sanitizeText(value, false);
}

function normalizeAvatarUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMaintenanceAccess(value) {
  return Boolean(value);
}

function normalizeMaintenanceAuthorized(data) {
  if (typeof data?.maintenanceAuthorized === 'boolean') {
    return data.maintenanceAuthorized;
  }
  return normalizeMaintenanceAccess(data?.maintenanceAccess);
}

const BLOCKED_USERNAMES = new Set([
  'FACEBOOK',
  'YOUTUBE',
  'TWITEER',
  'ANONYME',
  'TAY',
  'AMANY',
  'FORY',
  'VODY',
  'LATAKA',
  'BOBOTA',
  'BIBITY',
  'BIBY',
  'KINDY',
  'TABORY',
  'NEMANY',
  'FUCK',
  'JE T AIME',
  'GOOGLE',
]);

function isValidUsername(username) {
  const value = normalizeUsername(username);
  if (!/^[A-Za-z0-9]{4,20}$/.test(value)) {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return false;
  }
  if (BLOCKED_USERNAMES.has(value.toUpperCase())) {
    return false;
  }
  return true;
}

function getCurrentAuthUser() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    return null;
  }
  return {
    uid: authUser.uid,
    email: authUser.email || '',
    displayName: authUser.displayName || '',
    photoURL: authUser.photoURL || '',
  };
}

function isAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === 'andrainaaina@gmail.com';
}

function usersCollection() {
  return collection(state.db, 'users');
}

function userDocRef(userId = state.userId) {
  if (!userId) {
    return null;
  }
  return doc(state.db, 'users', userId);
}

function maintenanceDocRef() {
  return doc(state.db, 'appSettings', 'maintenance');
}

function trashSettingsDocRef() {
  return doc(state.db, 'appSettings', 'trash');
}

function trashCollection() {
  return collection(state.db, 'trash');
}

function parseFirestoreDate(value) {
  if (!value) {
    return null;
  }
  let normalizedValue = value;
  if (typeof value?.toDate === 'function') {
    normalizedValue = value.toDate();
  } else if (typeof value?.seconds === 'number') {
    normalizedValue = new Date(value.seconds * 1000);
  }
  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getInactiveUserCutoffDate(referenceDate = new Date()) {
  const cutoffDate = new Date(referenceDate);
  cutoffDate.setMonth(cutoffDate.getMonth() - 5);
  return cutoffDate;
}

async function recordCurrentUserActivity(extraUpdates = {}) {
  if (!state.userId) {
    return false;
  }
  await setDoc(
    userDocRef(),
    {
      ...extraUpdates,
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  return true;
}

async function isUsernameDuplicate(username, excludedUserId) {
  const normalizedTarget = normalizeUsername(username).toUpperCase();
  const snapshot = await getDocs(usersCollection());
  return snapshot.docs.some((snap) => {
    if (snap.id === excludedUserId) {
      return false;
    }
    const existing = normalizeUsername(snap.data()?.username).toUpperCase();
    return existing && existing === normalizedTarget;
  });
}

async function ensureCurrentUser() {
  if (!state.userId) {
    return null;
  }
  const ref = userDocRef();
  const snap = await getDoc(ref);
  const authDisplayName = String(state.authUser?.displayName || '').trim();
  const authEmail = String(state.authUser?.email || '').trim();
  const authPhotoUrl = String(state.authUser?.photoURL || '').trim();
  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        uid: state.userId,
        username: authDisplayName,
        displayName: authDisplayName,
        email: authEmail,
        name: authDisplayName,
        photoURL: authPhotoUrl,
        avatarUrl: authPhotoUrl,
        avatar: authPhotoUrl,
        role: 'Limité',
        status: deleteField(),
        approved: deleteField(),
        pending: deleteField(),
        maintenanceAuthorized: false,
        maintenanceAccess: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        lastActivity: serverTimestamp(),
        lastNameChange: null,
      },
      { merge: true },
    );
    return {
      id: state.userId,
      username: authDisplayName,
      avatarUrl: authPhotoUrl,
      role: 'limite',
      maintenanceAccess: false,
      maintenanceAuthorized: false,
      lastNameChange: null,
      createdAt: null,
    };
  }

  const data = snap.data() || {};
  const mergedMaintenanceAuthorized = normalizeMaintenanceAuthorized(data);
  const updates = {
    uid: state.userId,
    displayName: authDisplayName,
    email: authEmail,
    photoURL: authPhotoUrl,
    avatarUrl: authPhotoUrl,
    avatar: authPhotoUrl,
    lastLoginAt: serverTimestamp(),
    lastActivity: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (!Object.prototype.hasOwnProperty.call(data, 'role') || !String(data.role || '').trim()) {
    updates.role = 'Limité';
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'maintenanceAuthorized')) {
    updates.maintenanceAuthorized = false;
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'maintenanceAccess')) {
    updates.maintenanceAccess = mergedMaintenanceAuthorized;
  }

  await setDoc(ref, updates, { merge: true });

  if ('status' in data || 'approved' in data || 'pending' in data) {
    await setDoc(
      ref,
      {
        status: deleteField(),
        approved: deleteField(),
        pending: deleteField(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    email: String(data.email || state.authUser?.email || ''),
    id: snap.id,
    username: normalizeUsername(data.username || data.displayName || data.name || state.authUser?.displayName),
    role: normalizeRole(data.role),
    maintenanceAccess: normalizeMaintenanceAuthorized(data),
    maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
    lastNameChange: data.lastNameChange || null,
    avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
    createdAt: data.createdAt || null,
  };
}

async function getCurrentUserProfile() {
  if (!state.userId) {
    return {
      id: null,
      username: '',
      email: '',
      role: 'limite',
      maintenanceAccess: false,
      lastNameChange: null,
      avatarUrl: '',
      createdAt: null,
      guest: true,
    };
  }
  const ref = userDocRef();
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return ensureCurrentUser();
  }
  const data = snap.data() || {};
  return {
    email: String(data.email || state.authUser?.email || ''),
    id: snap.id,
    username: normalizeUsername(data.username || data.displayName || data.name || state.authUser?.displayName),
    role: normalizeRole(data.role),
    maintenanceAccess: normalizeMaintenanceAuthorized(data),
    maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
    lastNameChange: data.lastNameChange || null,
    avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
    createdAt: data.createdAt || null,
  };
}

function computeNextNameChangeDate(lastNameChange) {
  if (!lastNameChange) {
    return null;
  }
  const date = typeof lastNameChange.toDate === 'function' ? lastNameChange.toDate() : new Date(lastNameChange);
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

async function saveUsername(username) {
  const nextName = normalizeUsername(username);
  if (!isValidUsername(nextName)) {
    return { ok: false, reason: 'invalid_username' };
  }

  const profile = await getCurrentUserProfile();
  const duplicate = await isUsernameDuplicate(nextName, state.userId);
  if (duplicate) {
    return { ok: false, reason: 'duplicate_username' };
  }

  const isFirstUsername = !profile.username;
  const updates = {
    username: nextName,
    name: nextName,
    updatedAt: serverTimestamp(),
  };

  if (isFirstUsername) {
    updates.role = 'Limité';
    updates.status = deleteField();
    updates.approved = deleteField();
    updates.pending = deleteField();
  }

  await setDoc(
    userDocRef(),
    {
      ...updates,
      lastActivity: serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true, username: nextName };
}

async function changeUsername(username) {
  const profile = await getCurrentUserProfile();
  const nextAllowedAt = computeNextNameChangeDate(profile.lastNameChange);
  if (nextAllowedAt && new Date() < nextAllowedAt) {
    return { ok: false, reason: 'cooldown', nextAllowedAt };
  }

  const nextName = normalizeUsername(username);
  if (!isValidUsername(nextName)) {
    return { ok: false, reason: 'invalid_username' };
  }

  const duplicate = await isUsernameDuplicate(nextName, profile.id);
  if (duplicate) {
    return { ok: false, reason: 'duplicate_username' };
  }

  await setDoc(
    userDocRef(),
    {
      username: nextName,
      name: nextName,
      lastNameChange: Timestamp.fromDate(new Date()),
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true, username: nextName };
}

async function updateAvatarUrl(avatarUrl) {
  const nextAvatarUrl = normalizeAvatarUrl(avatarUrl);
  await setDoc(
    userDocRef(),
    {
      avatarUrl: nextAvatarUrl,
      avatar: nextAvatarUrl,
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  return { ok: true, avatarUrl: nextAvatarUrl };
}

async function listUsers() {
  const snapshot = await getDocs(usersCollection());
  return snapshot.docs
    .map((snap) => {
      const data = snap.data() || {};
      const email = String(data.email || '').trim();
      const fallbackName = email ? email.split('@')[0] : '';
      return {
        id: snap.id,
        username: normalizeUsername(data.username || data.displayName || data.name || fallbackName),
        rawUsername: normalizeUsername(data.username),
        displayName: normalizeUsername(data.displayName),
        name: normalizeUsername(data.name),
        email,
        avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
        role: normalizeRole(data.role),
        maintenanceAccess: normalizeMaintenanceAuthorized(data),
        maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
        createdAt: data.createdAt || null,
        lastActivity: data.lastActivity || null,
        lastSeen: data.lastSeen || null,
        online: data.online === true,
        presence: data.presence || null,
        status: data.status || null,
      };
    });
}

async function cleanupInactiveUsers(options = {}) {
  const cutoffDate = getInactiveUserCutoffDate(options.referenceDate || new Date());
  const snapshot = await getDocs(usersCollection());
  const deletedUserIds = [];
  const currentUserId = String(state.userId || '').trim();

  for (const userSnapshot of snapshot.docs) {
    const data = userSnapshot.data() || {};
    const email = String(data.email || '').trim();
    const lastActivityDate = parseFirestoreDate(data.lastActivity);
    if (!lastActivityDate || lastActivityDate >= cutoffDate || isAdminEmail(email) || userSnapshot.id === currentUserId) {
      continue;
    }
    await deleteDoc(userSnapshot.ref);
    deletedUserIds.push(userSnapshot.id);
  }

  return { deletedCount: deletedUserIds.length, deletedUserIds, cutoffDate };
}


function normalizeOutCreationPointsSnapshot(snapshot) {
  return snapshot.docs.reduce((pointsByUser, snap) => {
    const data = snap.data() || {};
    const creatorId = String(data.createdBy || data.ownerId || '').trim();
    if (!creatorId) {
      return pointsByUser;
    }
    pointsByUser[creatorId] = (pointsByUser[creatorId] || 0) + 1;
    return pointsByUser;
  }, {});
}

async function listOutCreationPoints() {
  const snapshot = await getDocs(makePageItemsCollection('page2'));
  return normalizeOutCreationPointsSnapshot(snapshot);
}

function subscribeOutCreationPoints(onChange, onError) {
  try {
    return onSnapshot(
      makePageItemsCollection('page2'),
      (snapshot) => {
        onChange(normalizeOutCreationPointsSnapshot(snapshot));
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

async function updateUserRole(userId, role) {
  const nextRole = normalizeRole(role);
  await setDoc(
    userDocRef(userId),
    {
      role: serializeRole(nextRole),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await recordCurrentUserActivity();
  return true;
}

async function updateUserMaintenanceAccess(userId, maintenanceAccess) {
  await setDoc(
    userDocRef(userId),
    {
      maintenanceAccess: Boolean(maintenanceAccess),
      maintenanceAuthorized: Boolean(maintenanceAccess),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await recordCurrentUserActivity();
  return true;
}

async function deleteUser(userId) {
  const targetId = String(userId || '').trim();
  if (!targetId) {
    return false;
  }
  const snap = await getDoc(userDocRef(targetId));
  if (await isTrashEnabled() && snap.exists()) {
    await addTrashEntry('user', targetId, { user: { id: targetId, ...(snap.data() || {}) } });
  }
  await deleteDoc(userDocRef(targetId));
  await recordCurrentUserActivity();
  return true;
}

function subscribeCurrentUserProfile(onChange, onError) {
  try {
    return onSnapshot(
      userDocRef(),
      (snapshot) => {
        if (!snapshot.exists()) {
          onChange({
            id: state.userId,
            username: '',
            role: isAdminEmail(state.authUser?.email) ? 'admin' : 'limite',
            maintenanceAccess: false,
            lastNameChange: null,
            avatarUrl: '',
            createdAt: null,
            missing: true,
          });
          return;
        }
        const data = snapshot.data() || {};
        onChange({
          id: snapshot.id,
          username: normalizeUsername(data.username || data.name),
          role: normalizeRole(data.role),
          maintenanceAccess: normalizeMaintenanceAccess(data.maintenanceAccess),
          lastNameChange: data.lastNameChange || null,
          avatarUrl: normalizeAvatarUrl(data.avatarUrl || data.avatar),
          createdAt: data.createdAt || null,
          missing: false,
        });
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeUsers(onChange, onError) {
  try {
    return onSnapshot(
      usersCollection(),
      (snapshot) => {
        console.log('[users] snapshot size:', snapshot.size);
        snapshot.docs.forEach((snap) => {
          console.log('[users] doc id:', snap.id, snap.data());
        });
        const users = snapshot.docs
          .map((snap) => {
            const data = snap.data() || {};
            const email = String(data.email || '').trim();
            const fallbackName = email ? email.split('@')[0] : '';
            return {
              id: snap.id,
              username: normalizeUsername(data.username || data.displayName || data.name || fallbackName),
              email,
              avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
              role: normalizeRole(data.role),
              maintenanceAccess: normalizeMaintenanceAuthorized(data),
              maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
              createdAt: data.createdAt || null,
              lastActivity: data.lastActivity || null,
              lastSeen: data.lastSeen || null,
              online: data.online === true,
              presence: data.presence || null,
              status: data.status || null,
            };
          });
        onChange(users);
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function normalizeMaintenanceState(value) {
  return {
    enabled: Boolean(value?.enabled),
  };
}

async function setMaintenanceState(enabled) {
  await setDoc(
    maintenanceDocRef(),
    {
      enabled: Boolean(enabled),
      updatedAt: serverTimestamp(),
      updatedBy: state.userId || null,
    },
    { merge: true },
  );
  await recordCurrentUserActivity();
  return true;
}

function subscribeMaintenanceState(onChange, onError) {
  try {
    return onSnapshot(
      maintenanceDocRef(),
      (snapshot) => {
        onChange(normalizeMaintenanceState(snapshot.exists() ? snapshot.data() : { enabled: false }));
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeTrim(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeText(value, uppercase) {
  const cleaned = safeTrim(value).replace(/[<>]/g, '');
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

function sanitizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function sanitizeNumber(value) {
  if (value === '' || value === null || value === undefined) {
    return '';
  }
  const normalizedValue = typeof value === 'string' ? value.trim().replace(',', '.') : value;
  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sanitizeReturnDate(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function sanitizeDetailStatut(value) {
  return String(value || '').trim().toUpperCase() === 'K.O' ? 'K.O' : 'OK';
}

function nowIso() {
  return new Date().toISOString();
}

async function resolveCurrentUserName() {
  const profile = await getCurrentUserProfile();
  const rawName = profile?.username || state.authUser?.displayName || '';
  return sanitizeText(rawName, false) || 'Utilisateur';
}

function resolveCurrentUserEmail() {
  return String(state.authUser?.email || firebaseAuth.currentUser?.email || '').trim();
}

function uid() {
  return `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function makePageItemsCollection(pageName) {
  return collection(state.db, 'pages', pageName, 'items');
}

function getOutDeletionLimitDateKey(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0');
  const day = String(referenceDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function outDeletionLimitDocRef(userId, dateKey = getOutDeletionLimitDateKey()) {
  return doc(state.db, 'users', userId, 'outDeletionLimits', dateKey);
}

async function hasReachedOutDeletionLimit(userId, limit = 2) {
  if (!userId) {
    return true;
  }
  const limitSnap = await getDoc(outDeletionLimitDocRef(userId));
  const currentCount = Number(limitSnap.exists() ? limitSnap.data()?.count : 0);
  return currentCount >= limit;
}

async function recordOutDeletionLimitUsage(userId) {
  if (!userId) {
    return;
  }
  const dateKey = getOutDeletionLimitDateKey();
  const limitRef = outDeletionLimitDocRef(userId, dateKey);
  const limitSnap = await getDoc(limitRef);
  const currentCount = Number(limitSnap.exists() ? limitSnap.data()?.count : 0);
  await setDoc(
    limitRef,
    {
      date: dateKey,
      count: currentCount + 1,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

function historyCollection() {
  return collection(state.db, 'historiques');
}


function normalizeReturnEntry(entry) {
  const quantity = sanitizeNumber(entry?.quantity);
  const date = sanitizeReturnDate(entry?.date);
  if (!quantity || !date) {
    return null;
  }
  return {
    id: sanitizeText(entry?.id || uid(), false) || uid(),
    quantity,
    date,
    note: sanitizeText(entry?.note, false),
    createdAt: entry?.createdAt || null,
    createdBy: sanitizeText(entry?.createdBy, false) || null,
  };
}

function getDetailReturns(detail) {
  const explicitReturns = Array.isArray(detail?.returns)
    ? detail.returns.map(normalizeReturnEntry).filter(Boolean)
    : [];
  if (explicitReturns.length) {
    return explicitReturns;
  }
  const legacyQuantity = sanitizeNumber(detail?.qteRetour);
  const legacyDate = sanitizeReturnDate(detail?.dateRetour);
  if (legacyQuantity > 0 && legacyDate) {
    return [{
      id: 'legacy-return',
      quantity: legacyQuantity,
      date: legacyDate,
      note: '',
      createdAt: detail?.dateModification || detail?.dateCreation || null,
      createdBy: sanitizeText(detail?.createdBy || detail?.ownerId, false) || null,
      legacy: true,
    }];
  }
  return [];
}

function getTotalReturnQuantity(detail) {
  const returns = getDetailReturns(detail);
  if (returns.length) {
    return sumReturnQuantities(returns.map((entry) => entry.quantity));
  }
  return sanitizeNumber(detail?.qteRetour);
}

function normalizeDetailForState(detail) {
  const normalized = { ...detail };
  normalized.returns = getDetailReturns(normalized);
  normalized.qteRetour = getTotalReturnQuantity(normalized);
  normalized.dateRetour = normalized.returns.length
    ? normalized.returns.map((entry) => entry.date).filter(Boolean).join('\n')
    : sanitizeReturnDate(normalized.dateRetour);
  return normalized;
}

function normalizeDocData(docSnapshot) {
  const data = docSnapshot.data() || {};
  const item = { id: docSnapshot.id, ...data };
  return docSnapshot.ref?.parent?.parent?.id === 'page3' ? normalizeDetailForState(item) : item;
}

function normalizeOutCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function normalizeArticleCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function getActualOutCountForSite(siteId) {
  return (state.itemsBySite.get(String(siteId || '')) || []).length;
}

function getActualArticleCountForItem(siteId, itemId) {
  return (state.detailsByItem.get(`${String(siteId || '')}:${String(itemId || '')}`) || []).length;
}

function applyItemArticleCount(siteId, itemId, articleCount) {
  const items = state.itemsBySite.get(String(siteId || '')) || [];
  const item = items.find((entry) => entry.id === String(itemId || ''));
  if (item) {
    item.articleCount = normalizeArticleCount(articleCount);
  }
}

function itemDocRef(itemId) {
  return doc(state.db, 'pages', 'page2', 'items', itemId);
}

async function setItemArticleCount(siteId, itemId, articleCount) {
  const normalizedSiteId = sanitizeText(siteId, false);
  const normalizedItemId = sanitizeText(itemId, false);
  if (!normalizedSiteId || !normalizedItemId) {
    return false;
  }
  const normalizedCount = normalizeArticleCount(articleCount);
  await setDoc(itemDocRef(normalizedItemId), { articleCount: normalizedCount }, { merge: true });
  applyItemArticleCount(normalizedSiteId, normalizedItemId, normalizedCount);
  return true;
}

async function incrementItemArticleCount(siteId, itemId, delta) {
  const normalizedSiteId = sanitizeText(siteId, false);
  const normalizedItemId = sanitizeText(itemId, false);
  const numericDelta = Number(delta);
  if (!normalizedSiteId || !normalizedItemId || !Number.isFinite(numericDelta) || numericDelta === 0) {
    return false;
  }
  const roundedDelta = Math.trunc(numericDelta);
  if (roundedDelta > 0) {
    await updateDoc(itemDocRef(normalizedItemId), { articleCount: increment(roundedDelta) });
    const items = state.itemsBySite.get(normalizedSiteId) || [];
    const currentItem = items.find((item) => item.id === normalizedItemId);
    applyItemArticleCount(normalizedSiteId, normalizedItemId, normalizeArticleCount(currentItem?.articleCount) + roundedDelta);
    return true;
  }

  await runTransaction(state.db, async (transaction) => {
    const ref = itemDocRef(normalizedItemId);
    const snap = await transaction.get(ref);
    const currentCount = normalizeArticleCount(snap.exists() ? snap.data()?.articleCount : 0);
    transaction.set(ref, { articleCount: Math.max(0, currentCount + roundedDelta) }, { merge: true });
  });
  const items = state.itemsBySite.get(normalizedSiteId) || [];
  const currentItem = items.find((item) => item.id === normalizedItemId);
  applyItemArticleCount(normalizedSiteId, normalizedItemId, Math.max(0, normalizeArticleCount(currentItem?.articleCount) + roundedDelta));
  return true;
}

function applySiteOutCount(siteId, outCount) {
  const site = state.sites.find((item) => item.id === siteId);
  if (site) {
    site.outCount = normalizeOutCount(outCount);
  }
}

function siteDocRef(siteId) {
  return doc(state.db, 'pages', 'page1', 'items', siteId);
}

async function setSiteOutCount(siteId, outCount) {
  const normalizedSiteId = sanitizeText(siteId, false);
  if (!normalizedSiteId) {
    return false;
  }
  const normalizedCount = normalizeOutCount(outCount);
  await setDoc(siteDocRef(normalizedSiteId), { outCount: normalizedCount }, { merge: true });
  applySiteOutCount(normalizedSiteId, normalizedCount);
  return true;
}

async function incrementSiteOutCount(siteId, delta) {
  const normalizedSiteId = sanitizeText(siteId, false);
  const numericDelta = Number(delta);
  if (!normalizedSiteId || !Number.isFinite(numericDelta) || numericDelta === 0) {
    return false;
  }
  if (numericDelta > 0) {
    await updateDoc(siteDocRef(normalizedSiteId), { outCount: increment(Math.trunc(numericDelta)) });
    const currentSite = state.sites.find((site) => site.id === normalizedSiteId);
    applySiteOutCount(normalizedSiteId, normalizeOutCount(currentSite?.outCount) + Math.trunc(numericDelta));
    return true;
  }

  await runTransaction(state.db, async (transaction) => {
    const ref = siteDocRef(normalizedSiteId);
    const snap = await transaction.get(ref);
    const currentCount = normalizeOutCount(snap.exists() ? snap.data()?.outCount : 0);
    transaction.set(ref, { outCount: Math.max(0, currentCount + Math.trunc(numericDelta)) }, { merge: true });
  });
  const currentSite = state.sites.find((site) => site.id === normalizedSiteId);
  applySiteOutCount(normalizedSiteId, Math.max(0, normalizeOutCount(currentSite?.outCount) + Math.trunc(numericDelta)));
  return true;
}

function buildArticleCountMigrationRows(siteIds = null) {
  const limitedSiteIds = siteIds ? new Set(Array.from(siteIds).map((siteId) => String(siteId || '')).filter(Boolean)) : null;
  const rows = [];
  state.itemsBySite.forEach((items, siteId) => {
    if (limitedSiteIds && !limitedSiteIds.has(siteId)) return;
    items.forEach((item) => {
      const actualArticleCount = getActualArticleCountForItem(siteId, item.id);
      const currentArticleCount = item.__articleCountWasMissing === true ? null : (Object.prototype.hasOwnProperty.call(item, 'articleCount') ? normalizeArticleCount(item.articleCount) : null);
      rows.push({
        out: sanitizeText(item.numero, false),
        itemId: item.id,
        siteId,
        actualArticleCount,
        currentArticleCount,
        difference: currentArticleCount === null ? actualArticleCount : currentArticleCount - actualArticleCount,
        needsUpdate: currentArticleCount !== actualArticleCount,
        missing: currentArticleCount === null,
      });
    });
  });
  return rows;
}

async function reconcileItemArticleCounts(siteIds = null, { logReport = false } = {}) {
  const rows = buildArticleCountMigrationRows(siteIds);
  if (logReport && rows.length) {
    console.table(rows.map((row) => ({
      OUT: row.out,
      itemId: row.itemId,
      'Nombre réel Page 3': row.actualArticleCount,
      articleCount: row.currentArticleCount === null ? 'absent' : row.currentArticleCount,
      Écart: row.difference,
    })));
  }
  await Promise.all(rows.filter((row) => row.needsUpdate).map((row) => setItemArticleCount(row.siteId, row.itemId, row.actualArticleCount)));
  rows.forEach((row) => {
    const items = state.itemsBySite.get(row.siteId) || [];
    const item = items.find((entry) => entry.id === row.itemId);
    if (item && Object.prototype.hasOwnProperty.call(item, '__articleCountWasMissing')) {
      delete item.__articleCountWasMissing;
    }
  });
  return {
    rows,
    outsProcessed: rows.length,
    articlesAnalyzed: rows.reduce((total, row) => total + row.actualArticleCount, 0),
    created: rows.filter((row) => row.missing).length,
    corrected: rows.filter((row) => !row.missing && row.needsUpdate).length,
    anomalies: 0,
  };
}

function buildOutCountMigrationRows(siteIds = null) {
  const limitedSiteIds = siteIds ? new Set(Array.from(siteIds).map((siteId) => String(siteId || '')).filter(Boolean)) : null;
  return state.sites
    .filter((site) => !limitedSiteIds || limitedSiteIds.has(site.id))
    .map((site) => {
      const actualOutCount = getActualOutCountForSite(site.id);
      const currentOutCount = site.__outCountWasMissing === true ? null : (Object.prototype.hasOwnProperty.call(site, 'outCount') ? normalizeOutCount(site.outCount) : null);
      return {
        siteName: sanitizeText(site.nom, false),
        siteId: site.id,
        actualOutCount,
        currentOutCount,
        needsUpdate: currentOutCount !== actualOutCount,
        missing: currentOutCount === null,
      };
    });
}

async function reconcileSiteOutCounts(siteIds = null, { logReport = false } = {}) {
  const rows = buildOutCountMigrationRows(siteIds);
  if (logReport && rows.length) {
    console.table(rows.map((row) => ({
      Site: row.siteName,
      siteId: row.siteId,
      'Nombre réel d\'OUT': row.actualOutCount,
      'outCount actuel': row.currentOutCount === null ? 'absent' : row.currentOutCount,
    })));
  }
  await Promise.all(rows.filter((row) => row.needsUpdate).map((row) => setSiteOutCount(row.siteId, row.actualOutCount)));
  rows.forEach((row) => {
    const site = state.sites.find((item) => item.id === row.siteId);
    if (site && Object.prototype.hasOwnProperty.call(site, '__outCountWasMissing')) {
      delete site.__outCountWasMissing;
    }
  });
  return {
    rows,
    sitesProcessed: rows.length,
    outsAnalyzed: rows.reduce((total, row) => total + row.actualOutCount, 0),
    created: rows.filter((row) => row.missing).length,
    corrected: rows.filter((row) => !row.missing && row.needsUpdate).length,
    anomalies: 0,
  };
}

function persistOfflineState() {
  const items = [];
  state.itemsBySite.forEach((value) => items.push(...value));
  const details = [];
  state.detailsByItem.forEach((value) => details.push(...value));
  const payload = {
    savedAt: nowIso(),
    pages: {
      page1: state.sites,
      page2: items,
      page3: details,
    },
    materialCodes: state.materialCodes,
  };
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(payload));
}

function parseOfflineState() {
  try {
    const raw = localStorage.getItem(OFFLINE_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const page1 = Array.isArray(parsed?.pages?.page1) ? parsed.pages.page1 : [];
    const page2 = Array.isArray(parsed?.pages?.page2) ? parsed.pages.page2 : [];
    const page3 = Array.isArray(parsed?.pages?.page3) ? parsed.pages.page3 : [];
    const materialCodes = Array.isArray(parsed?.materialCodes) ? parsed.materialCodes : [];
    const savedAt = typeof parsed?.savedAt === 'string' ? parsed.savedAt : null;
    const savedAtTime = savedAt ? new Date(savedAt).getTime() : NaN;
    const isFresh = Number.isFinite(savedAtTime) && Date.now() - savedAtTime < OFFLINE_CACHE_TTL_MS;
    return {
      snapshot: { page1, page2, page3, materialCodes },
      savedAt,
      isFresh,
    };
  } catch (_error) {
    return null;
  }
}

async function readPageItems(pageName) {
  const pageRef = makePageItemsCollection(pageName);
  const snapshot = await getDocs(pageRef);
  return snapshot.docs.map(normalizeDocData);
}

async function readPage2ItemsBySite(siteId) {
  const normalizedSiteId = String(siteId || '').trim();
  if (!normalizedSiteId) {
    return [];
  }
  const snapshot = await getDocs(query(makePageItemsCollection('page2'), where('siteId', '==', normalizedSiteId)));
  return snapshot.docs.map(normalizeDocData);
}

function materialCodesCollection() {
  return collection(state.db, 'materialCodes');
}

function normalizeMaterialCodeKey(code) {
  return sanitizeText(code, false).toLowerCase();
}

function materialCodeDocId(code) {
  return encodeURIComponent(normalizeMaterialCodeKey(code)).replace(/\./g, '%2E');
}

function normalizeMaterialCodeEntry(entry) {
  const code = sanitizeText(entry?.code, true);
  if (!code) return null;
  return { id: entry?.id || materialCodeDocId(code), code, designation: sanitizeText(entry?.designation, false) };
}

async function readMaterialCodes() {
  const snapshot = await getDocs(materialCodesCollection());
  return snapshot.docs.map(normalizeDocData).map(normalizeMaterialCodeEntry).filter(Boolean);
}

async function bootstrapMaterialCodesFromDetails() {
  const details = await readPageItems('page3');
  const suggestionsByCode = new Map();
  details.forEach((detail) => {
    const code = sanitizeText(detail?.code, true);
    if (!code) return;
    const key = normalizeMaterialCodeKey(code);
    const designation = sanitizeText(detail?.designation, false);
    if (!suggestionsByCode.has(key)) {
      suggestionsByCode.set(key, { id: materialCodeDocId(code), code, designation });
      return;
    }
    const existing = suggestionsByCode.get(key);
    if (!existing.designation && designation) existing.designation = designation;
  });
  const entries = Array.from(suggestionsByCode.values());
  await Promise.all(entries.map((entry) => setDoc(doc(state.db, 'materialCodes', entry.id), { code: entry.code, designation: entry.designation }, { merge: true })));
  return entries;
}

async function loadRemoteSnapshot() {
  const page1 = await readPageItems('page1');
  return { page1, page3: [] };
}

function applySnapshot(snapshot) {
  state.sites = Array.isArray(snapshot.page1) ? clone(snapshot.page1) : [];

  if (Object.prototype.hasOwnProperty.call(snapshot, 'page2')) {
    state.itemsBySite = new Map();
    state.loadedItemSites = new Set();
    (Array.isArray(snapshot.page2) ? snapshot.page2 : []).forEach((item) => {
      const siteId = String(item.siteId || '');
      if (!siteId) {
        return;
      }
      if (!state.itemsBySite.has(siteId)) {
        state.itemsBySite.set(siteId, []);
      }
      state.itemsBySite.get(siteId).push(normalizePage2ItemForState(item));
      state.loadedItemSites.add(siteId);
    });
  }

  state.sites.forEach((site) => {
    if (!Object.prototype.hasOwnProperty.call(site, 'outCount')) {
      Object.defineProperty(site, '__outCountWasMissing', { value: true, configurable: true });
      site.outCount = 0;
    } else {
      site.outCount = normalizeOutCount(site.outCount);
    }
  });

  state.detailsByItem = new Map();
  (Array.isArray(snapshot.page3) ? snapshot.page3 : []).forEach((detail) => {
    const siteId = String(detail.siteId || '');
    const itemId = String(detail.itemId || '');
    if (!siteId || !itemId) {
      return;
    }
    const key = `${siteId}:${itemId}`;
    if (!state.detailsByItem.has(key)) {
      state.detailsByItem.set(key, []);
    }
    state.detailsByItem.get(key).push(detail);
  });

  if (Array.isArray(snapshot.materialCodes)) {
    state.materialCodes = snapshot.materialCodes.map(normalizeMaterialCodeEntry).filter(Boolean);
  }

  sortState();
}

function sortState() {
  state.sites.sort((a, b) => String(b.dateModification || '').localeCompare(String(a.dateModification || '')));
  state.itemsBySite.forEach((items) => {
    items.sort((a, b) => String(b.dateModification || '').localeCompare(String(a.dateModification || '')));
  });
  state.detailsByItem.forEach((details) => {
    details.sort((a, b) => Number(a.champ) - Number(b.champ));
  });
  state.materialCodes.sort((a, b) => a.code.localeCompare(b.code, 'fr', { sensitivity: 'base' }));
}

function emitForSite(siteId) {
  const items = clone(state.itemsBySite.get(siteId) || []);
  (state.listeners.itemsBySite.get(siteId) || new Set()).forEach((listener) => listener(items));

  const detailCounts = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      detailCounts[itemId] = details.length;
    }
  });
  (state.listeners.detailCountsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(detailCounts)));

  const designationsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId !== siteId) {
      return;
    }
    designationsByItem[itemId] = details.map((detail) => sanitizeText(detail.designation, true)).filter(Boolean);
  });
  (state.listeners.detailDesignationsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(designationsByItem)));

  const rowsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      rowsByItem[itemId] = clone(details).sort((a, b) => Number(a.champ) - Number(b.champ));
    }
  });
  (state.listeners.detailRowsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(rowsByItem)));
}

function emitAll() {
  state.listeners.sites.forEach((listener) => listener(filterSitesVisibleToCurrentUser()));

  const itemCounts = {};
  state.sites.forEach((site) => {
    itemCounts[site.id] = normalizeOutCount(site.outCount);
  });
  state.listeners.itemCounts.forEach((listener) => listener(clone(itemCounts)));

  state.listeners.itemsBySite.forEach((_listeners, siteId) => emitForSite(siteId));
  state.listeners.detailsByPair.forEach((listeners, key) => {
    const [siteId, itemId] = key.split(':');
    const details = clone(state.detailsByItem.get(`${siteId}:${itemId}`) || []);
    listeners.forEach((listener) => listener(details));
  });
}

async function init() {
  if (state.initialized) {
    return;
  }

  state.initialized = true;
  state.authUser = getCurrentAuthUser();
  state.userId = state.authUser?.uid || null;
  state.db = firebaseDb;

  const offlineState = parseOfflineState();
  if (offlineState?.snapshot) {
    applySnapshot(offlineState.snapshot);
  }

  if (!offlineState?.isFresh) {
    try {
      const remote = await loadRemoteSnapshot();
      applySnapshot(remote);
      persistOfflineState();
    } catch (_error) {
      if (!offlineState?.snapshot) {
        applySnapshot({ page1: [], page2: [], page3: [] });
      }
    }
  } else if (!offlineState.snapshot) {
    // Defensive fallback, should never happen.
    try {
      const remote = await loadRemoteSnapshot();
      applySnapshot(remote);
      persistOfflineState();
    } catch (_error) {
      applySnapshot({ page1: [], page2: [], page3: [] });
    }
  }
}


function getSiteInactivityThresholdDays() {
  return SITE_INACTIVITY_THRESHOLD_DAYS;
}

function getSiteOutCount(siteId) {
  const site = state.sites.find((item) => item.id === String(siteId || ''));
  return normalizeOutCount(site?.outCount ?? getActualOutCountForSite(siteId));
}

function isCurrentUserSiteCreator(site) {
  const currentUserId = String(state.userId || '').trim();
  const creatorId = String(site?.createdBy || site?.ownerId || '').trim();
  return Boolean(currentUserId && creatorId && currentUserId === creatorId);
}

function getInactiveSiteEligibleDate(site, referenceDate = new Date()) {
  if (getSiteOutCount(site?.id) !== 0) {
    return null;
  }
  const inactiveSince = parseFirestoreDate(site?.inactiveSince);
  if (!inactiveSince) {
    return null;
  }
  return new Date(inactiveSince.getTime() + SITE_INACTIVITY_THRESHOLD_DAYS * DAY_IN_MS);
}

function isSitePendingInactivityDecision(site, referenceDate = new Date()) {
  if (!site) {
    return false;
  }
  if (site?.inactivityDecisionPending === true) {
    return true;
  }
  const eligibleDate = getInactiveSiteEligibleDate(site, referenceDate);
  return Boolean(eligibleDate && eligibleDate.getTime() <= referenceDate.getTime());
}

function isSiteVisibleToCurrentUser(site, referenceDate = new Date()) {
  return !isSitePendingInactivityDecision(site, referenceDate) || isCurrentUserSiteCreator(site);
}

function filterSitesVisibleToCurrentUser(sites = state.sites, referenceDate = new Date()) {
  return clone((Array.isArray(sites) ? sites : []).filter((site) => isSiteVisibleToCurrentUser(site, referenceDate)));
}

async function refreshSiteInactivityStates(referenceDate = new Date()) {
  const updates = [];
  const nowValue = referenceDate.toISOString();

  for (const site of state.sites) {
    const siteId = String(site?.id || '').trim();
    if (!siteId) {
      continue;
    }
    const outCount = getSiteOutCount(siteId);
    const hasInactiveSince = Boolean(parseFirestoreDate(site?.inactiveSince));
    if (outCount === 0 && !hasInactiveSince) {
      const payload = {
        inactiveSince: nowValue,
        inactivityDecisionPending: false,
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      Object.assign(site, payload);
      continue;
    }
    const pendingEligibleDate = getInactiveSiteEligibleDate(site, referenceDate);
    if (outCount === 0 && pendingEligibleDate && pendingEligibleDate.getTime() <= referenceDate.getTime() && site?.inactivityDecisionPending !== true) {
      const payload = {
        inactivityDecisionPending: true,
        inactivityDecisionPendingAt: nowValue,
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      Object.assign(site, payload);
      continue;
    }
    if (outCount > 0 && (hasInactiveSince || site?.inactivityDecisionPending)) {
      const payload = {
        inactiveSince: deleteField(),
        inactivityDecisionPending: deleteField(),
        inactivityDecisionPendingAt: deleteField(),
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      delete site.inactiveSince;
      delete site.inactivityDecisionPending;
      delete site.inactivityDecisionPendingAt;
    }
  }

  if (updates.length) {
    await Promise.all(updates);
    persistOfflineState();
    emitAll();
  }
  return listInactiveSitesForCurrentCreator(referenceDate);
}

function listInactiveSitesForCurrentCreator(referenceDate = new Date()) {
  return clone(state.sites.filter((site) => isCurrentUserSiteCreator(site) && isSitePendingInactivityDecision(site, referenceDate)));
}

async function restoreInactiveSite(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1 || !isCurrentUserSiteCreator(state.sites[siteIndex])) {
    return { ok: false, reason: 'site_not_found' };
  }
  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    {
      inactiveSince: deleteField(),
      inactivityDecisionPending: deleteField(),
      inactivityDecisionPendingAt: deleteField(),
      inactivityRestoredAt: timestamp,
      dateModification: timestamp,
    },
    { merge: true },
  );
  delete state.sites[siteIndex].inactiveSince;
  delete state.sites[siteIndex].inactivityDecisionPending;
  delete state.sites[siteIndex].inactivityDecisionPendingAt;
  state.sites[siteIndex].inactivityRestoredAt = timestamp;
  state.sites[siteIndex].dateModification = timestamp;
  await appendHistoryEntry(`a restauré le site inactif ${state.sites[siteIndex].nom}`, { siteId, siteName: state.sites[siteIndex].nom });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

function getSite(siteId) {
  const site = state.sites.find((item) => item.id === siteId) || null;
  return site && isSiteVisibleToCurrentUser(site) ? clone(site) : null;
}

function getSites() {
  return filterSitesVisibleToCurrentUser();
}

function getItem(siteId, itemId) {
  const items = state.itemsBySite.get(siteId) || [];
  return clone(items.find((item) => item.id === itemId) || null);
}

function subscribeFactory(registry, key, onChange) {
  if (!registry.has(key)) {
    registry.set(key, new Set());
  }
  const listeners = registry.get(key);
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function subscribeSites(onChange, onError) {
  try {
    state.listeners.sites.add(onChange);
    onChange(filterSitesVisibleToCurrentUser());
    return () => state.listeners.sites.delete(onChange);
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeItems(siteId, onChange, onError) {
  try {
    const normalizedSiteId = String(siteId || '').trim();
    const unsubscribe = subscribeFactory(state.listeners.itemsBySite, normalizedSiteId, onChange);
    onChange(state.loadedItemSites.has(normalizedSiteId) ? clone(state.itemsBySite.get(normalizedSiteId) || []) : []);
    ensureSiteItemsLoaded(normalizedSiteId)
      .then(() => onChange(clone(state.itemsBySite.get(normalizedSiteId) || [])))
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeItemCounts(onChange, onError) {
  try {
    state.listeners.itemCounts.add(onChange);
    const counts = {};
    state.sites.forEach((site) => {
      counts[site.id] = normalizeOutCount(site.outCount);
    });
    onChange(clone(counts));
    return () => state.listeners.itemCounts.delete(onChange);
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeDetails(siteId, itemId, onChange, onError) {
  try {
    const key = `${siteId}:${itemId}`;
    const unsubscribe = subscribeFactory(state.listeners.detailsByPair, key, onChange);
    onChange(clone(state.detailsByItem.get(key) || []));
    ensurePairDetailsLoaded(siteId, itemId)
      .then(() => {
        onChange(clone(state.detailsByItem.get(key) || []));
      })
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function buildDetailCountsForSite(siteId) {
  const counts = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      counts[itemId] = details.length;
    }
  });
  return counts;
}

function subscribeDetailCounts(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailCountsBySite, siteId, onChange);
    onChange(clone(buildDetailCountsForSite(siteId)));
    ensureSiteDetailsLoaded(siteId)
      .then(() => onChange(clone(buildDetailCountsForSite(siteId))))
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function buildDetailDesignationsForSite(siteId) {
  const designationsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      designationsByItem[itemId] = details.map((detail) => sanitizeText(detail.designation, true)).filter(Boolean);
    }
  });
  return designationsByItem;
}

function subscribeDetailDesignations(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailDesignationsBySite, siteId, onChange);
    onChange(clone(buildDetailDesignationsForSite(siteId)));
    ensureSiteDetailsLoaded(siteId)
      .then(() => onChange(clone(buildDetailDesignationsForSite(siteId))))
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function buildDetailRowsForSite(siteId) {
  const rowsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      rowsByItem[itemId] = clone(details).sort((a, b) => Number(a.champ) - Number(b.champ));
    }
  });
  return rowsByItem;
}

function subscribeDetailRows(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailRowsBySite, siteId, onChange);
    onChange(clone(buildDetailRowsForSite(siteId)));
    ensureSiteDetailsLoaded(siteId)
      .then(() => onChange(clone(buildDetailRowsForSite(siteId))))
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

async function getDetailRowsBySite(siteId) {
  await ensureSiteDetailsLoaded(siteId);
  return clone(buildDetailRowsForSite(siteId));
}

async function getAllDetails() {
  const details = [];
  state.detailsByItem.forEach((itemDetails) => {
    details.push(...itemDetails);
  });
  return clone(details);
}

async function getMaterialCodes() {
  if (!state.materialCodes.length) {
    try {
      state.materialCodes = await readMaterialCodes();
      if (!state.materialCodes.length) {
        state.materialCodes = await bootstrapMaterialCodesFromDetails();
      }
      sortState();
      persistOfflineState();
    } catch (_error) {
      // Keep cached catalogue when Firestore is unavailable.
    }
  }
  return clone(state.materialCodes);
}

async function ensureMaterialCode(code, designation) {
  const normalizedCode = sanitizeText(code, true);
  if (!normalizedCode) return;
  const normalizedDesignation = sanitizeText(designation, false);
  const key = normalizeMaterialCodeKey(normalizedCode);
  const existing = state.materialCodes.find((entry) => normalizeMaterialCodeKey(entry.code) === key);
  if (existing) {
    if (!existing.designation && normalizedDesignation) {
      existing.designation = normalizedDesignation;
      await setDoc(doc(state.db, 'materialCodes', existing.id || materialCodeDocId(normalizedCode)), { code: existing.code, designation: existing.designation }, { merge: true });
    }
    return;
  }
  const entry = { id: materialCodeDocId(normalizedCode), code: normalizedCode, designation: normalizedDesignation };
  await setDoc(doc(state.db, 'materialCodes', entry.id), { code: entry.code, designation: entry.designation }, { merge: true });
  state.materialCodes.push(entry);
  sortState();
}

async function readDetailsByQuery(...constraints) {
  const snapshot = await getDocs(query(makePageItemsCollection('page3'), ...constraints));
  return snapshot.docs.map(normalizeDocData);
}

function mergeDetails(details) {
  details.forEach((detail) => {
    const siteId = String(detail.siteId || '');
    const itemId = String(detail.itemId || '');
    if (!siteId || !itemId) return;
    const key = `${siteId}:${itemId}`;
    if (!state.detailsByItem.has(key)) state.detailsByItem.set(key, []);
    const bucket = state.detailsByItem.get(key);
    const index = bucket.findIndex((item) => item.id === detail.id);
    if (index === -1) bucket.push(detail);
    else bucket[index] = detail;
  });
  sortState();
}

async function ensureSiteDetailsLoaded(siteId) {
  const normalizedSiteId = String(siteId || '');
  if (!normalizedSiteId || state.loadedDetailSites.has(normalizedSiteId)) return;
  const details = await readDetailsByQuery(where('siteId', '==', normalizedSiteId));
  mergeDetails(details);
  await ensureSiteItemsLoaded(normalizedSiteId);
  await reconcileItemArticleCounts(new Set([normalizedSiteId]));
  state.loadedDetailSites.add(normalizedSiteId);
  details.forEach((detail) => state.loadedDetailPairs.add(`${detail.siteId}:${detail.itemId}`));
  persistOfflineState();
  emitForSite(normalizedSiteId);
}

async function ensurePairDetailsLoaded(siteId, itemId) {
  const key = `${siteId}:${itemId}`;
  if (!siteId || !itemId || state.loadedDetailPairs.has(key) || state.loadedDetailSites.has(String(siteId))) return;
  const details = await readDetailsByQuery(where('siteId', '==', String(siteId)), where('itemId', '==', String(itemId)));
  state.detailsByItem.set(key, []);
  mergeDetails(details);
  state.loadedDetailPairs.add(key);
  persistOfflineState();
  emitForSite(String(siteId));
  (state.listeners.detailsByPair.get(key) || new Set()).forEach((listener) => listener(clone(state.detailsByItem.get(key) || [])));
}


function normalizePage2ItemForState(item) {
  if (!Object.prototype.hasOwnProperty.call(item, 'articleCount')) {
    Object.defineProperty(item, '__articleCountWasMissing', { value: true, configurable: true, enumerable: true });
    item.articleCount = 0;
  } else {
    item.articleCount = normalizeArticleCount(item.articleCount);
  }
  return item;
}

function mergeSiteItems(siteId, items) {
  const normalizedSiteId = String(siteId || '').trim();
  if (!normalizedSiteId) return;
  state.itemsBySite.set(
    normalizedSiteId,
    (Array.isArray(items) ? items : [])
      .filter((item) => String(item.siteId || '') === normalizedSiteId)
      .map(normalizePage2ItemForState),
  );
  state.loadedItemSites.add(normalizedSiteId);
  sortState();
}

async function ensureSiteItemsLoaded(siteId) {
  const normalizedSiteId = String(siteId || '').trim();
  if (!normalizedSiteId || state.loadedItemSites.has(normalizedSiteId)) return;
  state.itemsBySite.set(normalizedSiteId, []);
  emitForSite(normalizedSiteId);
  const items = await readPage2ItemsBySite(normalizedSiteId);
  mergeSiteItems(normalizedSiteId, items);
  persistOfflineState();
  emitAll();
}

function isDuplicateSiteName(name) {
  const normalized = sanitizeText(name, true);
  if (!normalized) {
    return false;
  }
  return state.sites.some((site) => sanitizeText(site.nom, true) === normalized);
}

function isDuplicateItemNumber(siteId, numero) {
  const normalized = sanitizeText(numero, true);
  if (!normalized) {
    return false;
  }
  const items = state.itemsBySite.get(siteId) || [];
  return items.some((item) => sanitizeText(item.numero, true) === normalized);
}

function isDuplicateDetailDesignation(siteId, itemId, designation) {
  const normalized = sanitizeText(designation, true);
  if (!normalized) {
    return false;
  }
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  return details.some((detail) => sanitizeText(detail.designation, true) === normalized);
}

function withoutId(payload) {
  const copy = { ...payload };
  delete copy.id;
  return copy;
}

async function createSite(name) {
  const siteName = sanitizeText(name, true);
  if (!siteName) {
    return { ok: false, reason: 'invalid_name' };
  }
  if (isDuplicateSiteName(siteName)) {
    return { ok: false, reason: 'duplicate_site' };
  }

  const timestamp = nowIso();
  const creatorName = await resolveCurrentUserName();
  const sitePayload = {
    nom: siteName,
    outCount: 0,
    ownerId: state.userId,
    createdBy: state.userId,
    createdByName: creatorName,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page1'), sitePayload);
  const site = { id: created.id, ...sitePayload };

  state.sites.unshift(site);
  await appendHistoryEntry(`a créé le site ${site.nom}`, { siteId: site.id, siteName: site.nom });
  persistOfflineState();
  emitAll();
  return { ok: true, id: site.id };
}

async function updateSiteName(siteId, name) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const siteName = sanitizeText(name, true);
  if (!siteName) {
    return { ok: false, reason: 'invalid_name' };
  }

  const hasDuplicate = state.sites.some(
    (site, index) => index !== siteIndex && sanitizeText(site.nom, true) === siteName,
  );
  if (hasDuplicate) {
    return { ok: false, reason: 'duplicate_site' };
  }

  const previousSiteName = sanitizeText(state.sites[siteIndex]?.nom, false);
  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    { nom: siteName, dateModification: timestamp },
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    nom: siteName,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry(`a modifié le site ${previousSiteName || siteName} en ${siteName}`, { siteId, siteName });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function updateSiteCreator(siteId, user) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const userId = String(user?.id || user?.uid || '').trim();
  if (!userId) {
    return { ok: false, reason: 'invalid_user' };
  }

  const userName = normalizeUsername(user?.username || user?.displayName || user?.name || user?.email || 'Utilisateur') || 'Utilisateur';
  const userEmail = String(user?.email || '').trim();
  const timestamp = nowIso();
  const creatorPayload = {
    ownerId: userId,
    createdBy: userId,
    createdByName: userName,
    createdByEmail: userEmail,
    dateModification: timestamp,
  };

  await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), creatorPayload, { merge: true });

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    ...creatorPayload,
  };
  await appendHistoryEntry(`a changé le créateur du site ${state.sites[siteIndex].nom} en ${userName}`, {
    siteId,
    siteName: state.sites[siteIndex].nom,
  });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function setSiteLock(siteId, lockPayload) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const timestamp = nowIso();
  const resolvedLockerName = await resolveCurrentUserName();
  const lockerName = resolvedLockerName && resolvedLockerName !== 'Utilisateur' ? resolvedLockerName : 'Utilisateur inconnu';
  const lockerEmail = resolveCurrentUserEmail();
  const nextLockState = {
    isLocked: true,
    passwordHash: sanitizeText(lockPayload?.passwordHash, false),
    lockedAt: timestamp,
    lockedBy: lockerEmail,
    lockedByName: lockerName,
    unlockedBy: deleteField(),
    unlockAttemptsRemaining: 3,
    unlockBlockedUntil: deleteField(),
    dateModification: timestamp,
  };

  if (!nextLockState.passwordHash) {
    return { ok: false, reason: 'invalid_password_hash' };
  }

  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    nextLockState,
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    ...nextLockState,
  };
  sortState();
  await appendHistoryEntry(lockPayload?.historyAction || 'a protégé le site par un mot de passe', { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function clearSiteLock(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const timestamp = nowIso();
  const resolvedUnlockerName = await resolveCurrentUserName();
  const unlockerName = resolvedUnlockerName && resolvedUnlockerName !== 'Utilisateur' ? resolvedUnlockerName : 'Utilisateur inconnu';
  const unlockerEmail = resolveCurrentUserEmail();
  const nextLockState = {
    isLocked: false,
    passwordHash: deleteField(),
    lockedAt: deleteField(),
    lockedByName: deleteField(),
    lockedBy: deleteField(),
    unlockedBy: unlockerEmail,
    unlockedByName: unlockerName,
    unlockAttemptsRemaining: deleteField(),
    unlockBlockedUntil: deleteField(),
    dateModification: timestamp,
  };

  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    nextLockState,
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    isLocked: false,
    passwordHash: '',
    lockedAt: null,
    lockedBy: '',
    lockedByName: '',
    unlockedBy: unlockerEmail,
    unlockedByName: unlockerName,
    unlockAttemptsRemaining: null,
    unlockBlockedUntil: null,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry('a retiré le mot de passe du site', { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function recordSiteUnlockHistory(siteId) {
  await appendHistoryEntry('a déverrouillé le site', { siteId });
}

async function recordSiteUnlockFailureHistory(siteId) {
  const profile = await getCurrentUserProfile();
  const username = normalizeUsername(profile?.username) || normalizeUsername(state.authUser?.displayName) || 'Utilisateur inconnu';
  const siteName = resolveSiteNameForHistory(siteId);
  const action = `${username} a essayé d'ouvrir le site « ${siteName || 'Site inconnu'} » avec un mot de passe incorrect.`;
  await appendHistoryEntry(action, { siteId, siteName });
}

async function recordExcelExportHistory(siteId, siteName = '') {
  const resolvedSiteName = resolveSiteNameForHistory(siteId, siteName);
  const action = resolvedSiteName
    ? `a exporté un fichier depuis le site « ${resolvedSiteName} ».`
    : 'a exporté un fichier depuis le site.';
  await appendHistoryEntry(action, { siteId, siteName: resolvedSiteName });
}

async function resetSiteUnlockProtection(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) {
    return { ok: false, reason: 'site_not_found' };
  }
  return { ok: true, isBlocked: false };
}

async function getSiteUnlockProtectionState(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) {
    return { ok: false, reason: 'site_not_found' };
  }
  return { ok: true, isBlocked: false };
}

async function registerSiteUnlockFailure(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) {
    return { ok: false, reason: 'site_not_found' };
  }
  return { ok: true, isBlocked: false };
}


async function isTrashEnabled() {
  const snapshot = await getDoc(trashSettingsDocRef());
  return Boolean(snapshot.exists() && snapshot.data()?.enabled);
}

function normalizeTrashEntry(snapshot) {
  const data = snapshot.data() || {};
  const deletedAtIso = typeof data.deletedAtIso === 'string' ? data.deletedAtIso : parseFirestoreDate(data.deletedAt)?.toISOString?.() || '';
  return { id: snapshot.id, ...data, deletedAtIso };
}

async function purgeExpiredTrashEntries() {
  const entries = await getDocs(trashCollection());
  const now = Date.now();
  const expired = entries.docs.filter((entry) => {
    const deletedAt = Date.parse(normalizeTrashEntry(entry).deletedAtIso || '');
    return Number.isFinite(deletedAt) && now - deletedAt >= DAY_IN_MS;
  });
  await Promise.all(expired.map((entry) => deleteDoc(entry.ref)));
}

async function addTrashEntry(type, originalId, payload) {
  const profile = await getCurrentUserProfile();
  const deletedBy = {
    id: profile?.id || state.userId || null,
    name: normalizeUsername(profile?.username) || normalizeUsername(state.authUser?.displayName) || 'Utilisateur inconnu',
    email: resolveCurrentUserEmail(),
  };
  const deletedAtIso = nowIso();
  await addDoc(trashCollection(), {
    type,
    originalId: sanitizeText(originalId, false),
    payload: clone(payload),
    deletedAt: serverTimestamp(),
    deletedAtIso,
    deletedBy,
  });
}

async function setTrashEnabled(enabled) {
  await setDoc(trashSettingsDocRef(), { enabled: Boolean(enabled), updatedAt: serverTimestamp() }, { merge: true });
  return Boolean(enabled);
}

function subscribeTrashSettings(onChange, onError) {
  return onSnapshot(trashSettingsDocRef(), (snapshot) => onChange({ enabled: Boolean(snapshot.exists() && snapshot.data()?.enabled) }), onError);
}

function subscribeTrashEntries(onChange, onError) {
  purgeExpiredTrashEntries().catch(() => {});
  return onSnapshot(query(trashCollection(), orderBy('deletedAtIso', 'desc')), (snapshot) => {
    const now = Date.now();
    onChange(snapshot.docs.map(normalizeTrashEntry).filter((entry) => {
      const deletedAt = Date.parse(entry.deletedAtIso || '');
      return !Number.isFinite(deletedAt) || now - deletedAt < DAY_IN_MS;
    }));
  }, onError);
}

async function restoreTrashEntry(entryId) {
  const ref = doc(state.db, 'trash', String(entryId || '').trim());
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    return false;
  }
  const entry = normalizeTrashEntry(snapshot);
  const deletedAt = Date.parse(entry.deletedAtIso || '');
  if (Number.isFinite(deletedAt) && Date.now() - deletedAt >= DAY_IN_MS) {
    await deleteDoc(ref);
    return false;
  }
  let restored = false;
  if (entry.type === 'site') restored = await restoreSite(entry.payload);
  if (entry.type === 'item') restored = await restoreItem(entry.payload);
  if (entry.type === 'detail') restored = await restoreDetail(entry.payload);
  if (entry.type === 'user' && entry.payload?.user?.id) {
    await setDoc(userDocRef(entry.payload.user.id), withoutId(entry.payload.user));
    restored = true;
  }
  if (restored) {
    await deleteDoc(ref);
  }
  return restored;
}

async function removeSite(siteId) {
  await ensureSiteItemsLoaded(siteId);
  await ensureSiteDetailsLoaded(siteId);
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return null;
  }

  const siteToRemove = state.sites[siteIndex];
  const profile = await getCurrentUserProfile();
  const currentUserId = String(state.userId || profile?.id || '').trim();
  const creatorId = String(siteToRemove?.createdBy || siteToRemove?.ownerId || '').trim();
  const normalizedRole = normalizeRole(profile?.role);
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'standard' || isAdminEmail(profile?.email);
  if (!isAdmin && (!currentUserId || !creatorId || currentUserId !== creatorId)) {
    return null;
  }

  const itemsToDelete = clone(state.itemsBySite.get(siteId) || []);
  const detailsSnapshot = [];
  Array.from(state.detailsByItem.entries()).forEach(([key, details]) => {
    if (key.startsWith(`${siteId}:`)) {
      detailsSnapshot.push(...clone(details));
    }
  });
  if (await isTrashEnabled()) {
    await addTrashEntry('site', siteId, { site: clone(siteToRemove), items: itemsToDelete, details: detailsSnapshot });
  }
  const detailDeletePromises = [];
  Array.from(state.detailsByItem.entries()).forEach(([key, details]) => {
    if (key.startsWith(`${siteId}:`)) {
      details.forEach((detail) => detailDeletePromises.push(deleteDoc(doc(state.db, 'pages', 'page3', 'items', detail.id))));
    }
  });
  await Promise.all([
    ...detailDeletePromises,
    ...itemsToDelete.map((item) => deleteDoc(doc(state.db, 'pages', 'page2', 'items', item.id))),
    deleteDoc(doc(state.db, 'pages', 'page1', 'items', siteId)),
  ]);

  const [site] = state.sites.splice(siteIndex, 1);
  const items = clone(state.itemsBySite.get(siteId) || []);
  state.itemsBySite.delete(siteId);

  const details = [];
  Array.from(state.detailsByItem.keys()).forEach((key) => {
    if (key.startsWith(`${siteId}:`)) {
      details.push(...(state.detailsByItem.get(key) || []));
      state.detailsByItem.delete(key);
    }
  });

  await appendHistoryEntry(`a supprimé le site ${site.nom}`, { siteId, siteName: site.nom });
  persistOfflineState();
  emitAll();

  return { site: clone(site), items, details };
}

async function createItem(siteId, numberValue, options = {}) {
  await ensureSiteItemsLoaded(siteId);
  const cleanNumber = sanitizeDigits(sanitizeText(numberValue, true).replace(/^OUT-/, ''));
  if (cleanNumber.length < 4) {
    return { ok: false, reason: 'invalid_out' };
  }
  const numero = `OUT-${cleanNumber}`;
  if (isDuplicateItemNumber(siteId, numero)) {
    return { ok: false, reason: 'duplicate_out' };
  }

  const timestamp = nowIso();
  const creatorName = await resolveCurrentUserName();
  const itemPayload = {
    siteId,
    numero,
    articleCount: 0,
    magasin: sanitizeText(options?.magasin || 'None', true) || 'None',
    ownerId: state.userId,
    createdBy: state.userId,
    createdByName: creatorName,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page2'), itemPayload);
  await incrementSiteOutCount(siteId, 1);
  const item = { id: created.id, ...itemPayload };

  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex !== -1 && (state.sites[siteIndex].inactiveSince || state.sites[siteIndex].inactivityDecisionPending)) {
    await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), { inactiveSince: deleteField(), inactivityDecisionPending: deleteField(), inactivityDecisionPendingAt: deleteField(), dateModification: timestamp }, { merge: true });
    delete state.sites[siteIndex].inactiveSince;
    delete state.sites[siteIndex].inactivityDecisionPending;
    delete state.sites[siteIndex].inactivityDecisionPendingAt;
    state.sites[siteIndex].dateModification = timestamp;
  }

  if (!state.itemsBySite.has(siteId)) {
    state.itemsBySite.set(siteId, []);
  }
  state.itemsBySite.get(siteId).unshift(item);

  await appendHistoryEntry(`a créé ${item.numero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, id: item.id };
}

async function updateItemName(siteId, itemId, nextValue) {
  const items = state.itemsBySite.get(siteId) || [];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    return { ok: false, reason: 'item_not_found' };
  }

  const rawValue = sanitizeText(nextValue, true);
  if (!rawValue) {
    return { ok: false, reason: 'invalid_out' };
  }

  let normalizedNumero = rawValue;
  if (!/^out-/i.test(normalizedNumero)) {
    const cleanDigits = sanitizeDigits(normalizedNumero.replace(/^OUT-/i, ''));
    if (cleanDigits.length < 4) {
      return { ok: false, reason: 'invalid_out' };
    }
    normalizedNumero = `OUT-${cleanDigits}`;
  }

  if (normalizedNumero.length < 4) {
    return { ok: false, reason: 'invalid_out' };
  }

  const currentNumero = sanitizeText(items[itemIndex]?.numero, true);
  if (sanitizeText(normalizedNumero, true) === currentNumero) {
    return { ok: true, unchanged: true };
  }

  const hasDuplicate = items.some(
    (item, index) => index !== itemIndex && sanitizeText(item.numero, true) === sanitizeText(normalizedNumero, true),
  );
  if (hasDuplicate) {
    return { ok: false, reason: 'duplicate_out' };
  }

  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page2', 'items', itemId),
    { numero: normalizedNumero, dateModification: timestamp },
    { merge: true },
  );

  items[itemIndex] = {
    ...items[itemIndex],
    numero: normalizedNumero,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry(`a modifié ${currentNumero || 'OUT inconnu'} en ${normalizedNumero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function removeItem(siteId, itemId) {
  await ensureSiteItemsLoaded(siteId);
  const items = state.itemsBySite.get(siteId) || [];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    return null;
  }

  const itemToRemove = items[itemIndex];
  const profile = await getCurrentUserProfile();
  const currentUserId = String(state.userId || profile?.id || '').trim();
  const creatorId = String(itemToRemove?.createdBy || itemToRemove?.ownerId || '').trim();
  const normalizedRole = normalizeRole(profile?.role);
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'standard' || isAdminEmail(profile?.email);
  const shouldCountDeletion = !isAdmin && (!currentUserId || !creatorId || currentUserId !== creatorId);
  if (shouldCountDeletion && await hasReachedOutDeletionLimit(currentUserId)) {
    return { limitReached: true };
  }

  if (await isTrashEnabled()) {
    await addTrashEntry('item', itemId, { item: clone(itemToRemove), details: clone(state.detailsByItem.get(`${siteId}:${itemId}`) || []) });
  }

  await deleteDoc(doc(state.db, 'pages', 'page2', 'items', itemId));
  await incrementSiteOutCount(siteId, -1);

  const [item] = items.splice(itemIndex, 1);
  const detailsKey = `${siteId}:${itemId}`;
  const details = clone(state.detailsByItem.get(detailsKey) || []);
  state.detailsByItem.delete(detailsKey);
  if (shouldCountDeletion) {
    await recordOutDeletionLimitUsage(currentUserId);
  }

  await appendHistoryEntry(`a supprimé ${item.numero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { item: clone(item), details };
}

async function restoreSite(snapshot) {
  const site = snapshot?.site;
  if (!site?.id) {
    return false;
  }

  try {
    const restoredSitePayload = { ...withoutId(site), outCount: Array.isArray(snapshot.items) ? snapshot.items.length : 0 };
    const createdSite = await addDoc(makePageItemsCollection('page1'), restoredSitePayload);
    const nextSite = { ...clone(site), ...restoredSitePayload, id: createdSite.id };
    const itemIdMap = new Map();
    const restoredItems = [];

    for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
      const restoredDetailCount = (Array.isArray(snapshot.details) ? snapshot.details : []).filter((detail) => detail.itemId === item.id).length;
      const itemPayload = { ...withoutId(item), siteId: nextSite.id, articleCount: restoredDetailCount };
      const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
      const nextItem = { ...itemPayload, id: createdItem.id };
      itemIdMap.set(item.id, nextItem.id);
      restoredItems.push(nextItem);
    }

    const restoredDetails = [];
    for (const detail of Array.isArray(snapshot.details) ? snapshot.details : []) {
      const nextItemId = itemIdMap.get(detail.itemId);
      if (!nextItemId) {
        continue;
      }
      const detailPayload = { ...withoutId(detail), siteId: nextSite.id, itemId: nextItemId };
      const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
      restoredDetails.push({ ...detailPayload, id: createdDetail.id });
    }

    state.sites.unshift(nextSite);
    restoredItems.forEach((item) => {
      if (!state.itemsBySite.has(item.siteId)) {
        state.itemsBySite.set(item.siteId, []);
      }
      state.itemsBySite.get(item.siteId).push(item);
    });
    restoredDetails.forEach((detail) => {
      const key = `${detail.siteId}:${detail.itemId}`;
      if (!state.detailsByItem.has(key)) {
        state.detailsByItem.set(key, []);
      }
      state.detailsByItem.get(key).push(detail);
    });
  } catch (_error) {
    return false;
  }

  persistOfflineState();
  emitAll();
  return true;
}

async function restoreItem(snapshot) {
  const item = snapshot?.item;
  if (!item?.id || !item.siteId) {
    return false;
  }

  try {
    const itemPayload = { ...withoutId(item), articleCount: Array.isArray(snapshot.details) ? snapshot.details.length : 0 };
    const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
    await incrementSiteOutCount(itemPayload.siteId, 1);
    const nextItem = { ...itemPayload, id: createdItem.id };
    if (!state.itemsBySite.has(nextItem.siteId)) {
      state.itemsBySite.set(nextItem.siteId, []);
    }
    state.itemsBySite.get(nextItem.siteId).push(nextItem);

    for (const detail of Array.isArray(snapshot.details) ? snapshot.details : []) {
      const detailPayload = {
        ...withoutId(detail),
        siteId: nextItem.siteId,
        itemId: nextItem.id,
      };
      const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
      const nextDetail = { ...detailPayload, id: createdDetail.id };
      const key = `${nextDetail.siteId}:${nextDetail.itemId}`;
      if (!state.detailsByItem.has(key)) {
        state.detailsByItem.set(key, []);
      }
      state.detailsByItem.get(key).push(nextDetail);
    }
  } catch (_error) {
    return false;
  }

  persistOfflineState();
  emitAll();
  return true;
}

async function restoreDetail(snapshot) {
  const detail = snapshot?.detail;
  if (!detail?.id || !detail.siteId || !detail.itemId) return false;
  try {
    const detailPayload = withoutId(detail);
    const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
    await incrementItemArticleCount(detailPayload.siteId, detailPayload.itemId, 1);
    const nextDetail = { ...detailPayload, id: createdDetail.id };
    const key = `${nextDetail.siteId}:${nextDetail.itemId}`;
    if (!state.detailsByItem.has(key)) state.detailsByItem.set(key, []);
    state.detailsByItem.get(key).push(nextDetail);
  } catch (_error) { return false; }
  persistOfflineState();
  emitAll();
  return true;
}

async function createDetail(siteId, itemId, payload) {
  const designation = sanitizeText(payload.designation, true);
  if (!designation) {
    return { ok: false, reason: 'invalid_designation' };
  }
  if (isDuplicateDetailDesignation(siteId, itemId, designation)) {
    return { ok: false, reason: 'duplicate_designation' };
  }

  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const timestamp = nowIso();
  const detailPayload = {
    siteId,
    itemId,
    champ: details.length + 1,
    code: sanitizeText(payload.code, true),
    designation,
    qteSortie: payload.qteSortie === '' ? '' : sanitizeNumber(payload.qteSortie),
    unite: sanitizeText(payload.unite || getAutomaticUnit(designation), false) || getAutomaticUnit(designation),
    qteHorsBtrs: '',
    qteRetour: 0,
    dateRetour: '',
    returns: [],
    qtePosee: 0,
    qteRebus: 0,
    observation: '',
    statut: sanitizeDetailStatut(payload.statut),
    ownerId: state.userId,
    createdBy: state.userId,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page3'), detailPayload);
  await incrementItemArticleCount(siteId, itemId, 1);
  const detail = { id: created.id, ...detailPayload };

  if (!state.detailsByItem.has(detailsKey)) {
    state.detailsByItem.set(detailsKey, []);
  }
  state.detailsByItem.get(detailsKey).push(detail);
  await ensureMaterialCode(detail.code, detail.designation);

  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a ajouté des articles dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, id: detail.id };
}

async function updateDetail(siteId, itemId, detailId, changes) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const target = details.find((detail) => detail.id === detailId);
  if (!target) {
    return null;
  }

  const syncedChanges = {};
  const nextValues = {};
  if ('code' in changes) {
    nextValues.code = sanitizeText(changes.code, true);
    syncedChanges.code = nextValues.code;
  }
  if ('designation' in changes) {
    nextValues.designation = sanitizeText(changes.designation, false);
    syncedChanges.designation = nextValues.designation;
  }
  if ('qteSortie' in changes) {
    nextValues.qteSortie = sanitizeNumber(changes.qteSortie);
    syncedChanges.qteSortie = nextValues.qteSortie;
  }
  if ('unite' in changes) {
    nextValues.unite = sanitizeText(changes.unite, false) || 'm';
    syncedChanges.unite = nextValues.unite;
  }
  if ('qteRetour' in changes) {
    nextValues.qteRetour = sanitizeNumber(changes.qteRetour);
    syncedChanges.qteRetour = nextValues.qteRetour;
  }
  if ('qtePosee' in changes) {
    nextValues.qtePosee = sanitizeNumber(changes.qtePosee);
    syncedChanges.qtePosee = nextValues.qtePosee;
  }
  if ('qteRebus' in changes) {
    nextValues.qteRebus = sanitizeNumber(changes.qteRebus);
    syncedChanges.qteRebus = nextValues.qteRebus;
  }
  if ('observation' in changes) {
    nextValues.observation = sanitizeText(changes.observation, false);
    syncedChanges.observation = nextValues.observation;
  }
  if ('dateRetour' in changes) {
    nextValues.dateRetour = sanitizeReturnDate(changes.dateRetour);
    syncedChanges.dateRetour = nextValues.dateRetour;
  }
  if ('statut' in changes) {
    nextValues.statut = sanitizeDetailStatut(changes.statut);
    syncedChanges.statut = nextValues.statut;
  }
  nextValues.dateModification = nowIso();
  syncedChanges.dateModification = nextValues.dateModification;

  await updateDoc(doc(state.db, 'pages', 'page3', 'items', detailId), syncedChanges);
  Object.assign(target, nextValues);
  if ('code' in syncedChanges || 'designation' in syncedChanges) {
    await ensureMaterialCode(target.code, target.designation);
  }
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a modifié un article dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return true;
}


async function addDetailReturn(siteId, itemId, detailId, payload) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const target = details.find((detail) => detail.id === detailId);
  if (!target) return { ok: false, reason: 'not_found' };

  const quantity = sanitizeNumber(payload?.quantity);
  const quantityValidation = validateDetailReturnQuantity(target, quantity);
  if (!quantityValidation.ok) return quantityValidation;
  const date = sanitizeReturnDate(payload?.date);
  if (!date) return { ok: false, reason: 'invalid_date' };
  const existingTotal = getTotalReturnQuantity(target);

  const returnEntry = {
    id: uid(),
    quantity,
    date,
    note: sanitizeText(payload?.note, false),
    createdAt: nowIso(),
    createdBy: state.userId || null,
  };
  const nextTotal = sumReturnQuantities([existingTotal, quantity]);
  const dateModification = nowIso();
  await updateDoc(doc(state.db, 'pages', 'page3', 'items', detailId), {
    returns: arrayUnion(returnEntry),
    qteRetour: nextTotal,
    dateRetour: date,
    dateModification,
  });
  target.returns = [...getDetailReturns(target), returnEntry];
  target.qteRetour = nextTotal;
  target.dateRetour = target.returns.map((entry) => entry.date).filter(Boolean).join('\n');
  target.dateModification = dateModification;
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a ajouté un retour dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, return: clone(returnEntry), qteRetour: nextTotal };
}

// This is deliberately shared by creation and inline editing so both actions
// enforce the same positive-decimal and available-return rules.
function validateDetailReturnQuantity(detail, quantity, replacedQuantity = 0) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reason: 'invalid_quantity' };
  }
  const existingTotal = getTotalReturnQuantity(detail);
  const available = roundReturnQuantity(sanitizeNumber(detail.qteSortie)
    - sanitizeNumber(detail.qtePosee)
    - sanitizeNumber(detail.qteRebus)
    - (existingTotal - sanitizeNumber(replacedQuantity)));
  if (sanitizeNumber(detail.qteSortie) > 0 && !isReturnQuantityWithinAvailable(quantity, available)) {
    return { ok: false, reason: 'quantity_exceeds_available', available: Math.max(0, available) };
  }
  return { ok: true };
}

async function updateDetailReturnQuantity(siteId, itemId, detailId, returnId, quantityValue) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const target = details.find((detail) => detail.id === detailId);
  const normalizedReturnId = sanitizeText(returnId, false);
  const quantity = sanitizeNumber(quantityValue);
  if (!target || !normalizedReturnId) return { ok: false, reason: 'not_found' };

  const detailRef = doc(state.db, 'pages', 'page3', 'items', detailId);
  const result = await runTransaction(state.db, async (transaction) => {
    const snapshot = await transaction.get(detailRef);
    if (!snapshot.exists()) return { ok: false, reason: 'not_found' };

    const detail = normalizeDetailForState({ id: snapshot.id, ...snapshot.data() });
    const returns = getDetailReturns(detail);
    const returnIndex = returns.findIndex((entry) => entry.id === normalizedReturnId);
    if (returnIndex === -1) return { ok: false, reason: 'return_not_found' };

    const selectedReturn = returns[returnIndex];
    const quantityValidation = validateDetailReturnQuantity(detail, quantity, selectedReturn.quantity);
    if (!quantityValidation.ok) return quantityValidation;

    const nextReturns = returns.map((entry, index) => (index === returnIndex ? { ...entry, quantity } : entry));
    const nextTotal = sumReturnQuantities(nextReturns.map((entry) => entry.quantity));
    const dateModification = nowIso();
    const updates = {
      qteRetour: nextTotal,
      dateRetour: nextReturns.map((entry) => entry.date).filter(Boolean).join('\n'),
      dateModification,
    };

    if (selectedReturn.legacy) {
      // Legacy records have no returns[] entry to edit; retain that storage shape.
      updates.qteRetour = quantity;
      updates.dateRetour = selectedReturn.date;
    } else {
      const storedReturns = Array.isArray(snapshot.data()?.returns) ? snapshot.data().returns : [];
      // Keep every original property (date, note, IDs and any future metadata)
      // and replace only the quantity of the selected entry.
      updates.returns = storedReturns.map((entry) => (
        sanitizeText(entry?.id, false) === normalizedReturnId ? { ...entry, quantity } : entry
      ));
    }
    transaction.update(detailRef, updates);
    return { ok: true, returns: nextReturns, qteRetour: updates.qteRetour, dateRetour: updates.dateRetour, dateModification };
  });

  if (!result.ok) return result;

  target.returns = result.returns;
  target.qteRetour = result.qteRetour;
  target.dateRetour = result.dateRetour;
  target.dateModification = result.dateModification;
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a modifié un retour dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, qteRetour: result.qteRetour };
}

async function removeDetailReturn(siteId, itemId, detailId, returnId) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const target = details.find((detail) => detail.id === detailId);
  const normalizedReturnId = sanitizeText(returnId, false);
  if (!target || !normalizedReturnId) return { ok: false, reason: 'not_found' };

  const detailRef = doc(state.db, 'pages', 'page3', 'items', detailId);
  const result = await runTransaction(state.db, async (transaction) => {
    const snapshot = await transaction.get(detailRef);
    if (!snapshot.exists()) return { ok: false, reason: 'not_found' };

    const detail = normalizeDetailForState({ id: snapshot.id, ...snapshot.data() });
    const returns = getDetailReturns(detail);
    const returnIndex = returns.findIndex((entry) => entry.id === normalizedReturnId);
    if (returnIndex === -1) return { ok: false, reason: 'return_not_found' };

    const nextReturns = returns.filter((_entry, index) => index !== returnIndex);
    const nextTotal = sumReturnQuantities(nextReturns.map((entry) => entry.quantity));
    const dateModification = nowIso();
    transaction.update(detailRef, {
      returns: nextReturns,
      qteRetour: nextTotal,
      dateRetour: nextReturns.map((entry) => entry.date).filter(Boolean).join('\n'),
      dateModification,
    });
    return { ok: true, returns: nextReturns, qteRetour: nextTotal, dateModification };
  });

  if (!result.ok) return result;

  target.returns = result.returns;
  target.qteRetour = result.qteRetour;
  target.dateRetour = result.returns.map((entry) => entry.date).filter(Boolean).join('\n');
  target.dateModification = result.dateModification;
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a supprimé un retour dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, qteRetour: result.qteRetour };
}

async function removeDetail(siteId, itemId, detailId) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const detailIndex = details.findIndex((detail) => detail.id === detailId);
  if (detailIndex === -1) {
    return false;
  }

  if (await isTrashEnabled()) {
    await addTrashEntry('detail', detailId, { detail: clone(details[detailIndex]) });
  }

  await deleteDoc(doc(state.db, 'pages', 'page3', 'items', detailId));
  await incrementItemArticleCount(siteId, itemId, -1);
  details.splice(detailIndex, 1);
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a supprimé un article dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return true;
}

function resolveSiteNameForHistory(siteId, fallbackName = '') {
  const explicitName = sanitizeText(fallbackName, false);
  if (explicitName) {
    return explicitName;
  }
  const normalizedSiteId = sanitizeText(siteId, false);
  if (!normalizedSiteId) {
    return '';
  }
  return sanitizeText(state.sites.find((site) => site.id === normalizedSiteId)?.nom, false);
}

async function appendHistoryEntry(actionText, context = {}) {
  const action = sanitizeText(actionText, false);
  if (!action) {
    return;
  }
  try {
    const profile = await getCurrentUserProfile();
    if (normalizeRole(profile?.role) === 'admin') {
      return;
    }

    const username = normalizeUsername(profile?.username) || normalizeUsername(state.authUser?.displayName) || 'Utilisateur inconnu';
    const siteId = sanitizeText(context?.siteId, false);
    const siteName = resolveSiteNameForHistory(siteId, context?.siteName);
    await addDoc(historyCollection(), {
      userId: profile?.id || state.userId || null,
      userName: username,
      action,
      siteId: siteId || null,
      siteName: siteName || null,
      createdAt: serverTimestamp(),
    });
    await pruneHistoryEntries();
  } catch (_error) {
    // L'historique ne doit pas bloquer l'action principale.
  } finally {
    recordCurrentUserActivity().catch(() => {});
  }
}

async function pruneHistoryEntries() {
  const snapshot = await getDocs(query(historyCollection(), orderBy('createdAt', 'desc')));
  if (snapshot.size <= 100) {
    return;
  }

  const docsToDelete = snapshot.docs.slice(100);
  await Promise.all(docsToDelete.map((historyDoc) => deleteDoc(historyDoc.ref)));
}

function normalizeHistoryDocument(snap) {
  const data = snap.data() || {};
  return {
    id: snap.id,
    userId: sanitizeText(data.userId, false),
    userName: normalizeUsername(data.userName) || 'Utilisateur inconnu',
    action: sanitizeText(data.action, false),
    siteId: sanitizeText(data.siteId, false),
    siteName: resolveSiteNameForHistory(data.siteId, data.siteName),
    createdAt: data.createdAt || null,
  };
}

async function recordSearchHistory(searchText, context = {}) {
  const queryText = sanitizeText(searchText, false);
  if (!queryText) {
    return;
  }
  await appendHistoryEntry(`a recherché « ${queryText} »`, context);
}

async function recordFilterHistory(filterName, context = {}) {
  const label = sanitizeText(filterName, false);
  if (!label) {
    return;
  }
  await appendHistoryEntry(`a appliqué le filtre « ${label} »`, context);
}

async function recordMaterialsPageOpenHistory() {
  await appendHistoryEntry('a cliqué sur « Demande matériels ».');
}

async function listHistoriques() {
  const snapshot = await getDocs(query(historyCollection(), orderBy('createdAt', 'desc')));
  return snapshot.docs.map(normalizeHistoryDocument);
}

function subscribeHistoriques(onChange, onError) {
  return onSnapshot(
    query(historyCollection(), orderBy('createdAt', 'desc')),
    (snapshot) => {
      onChange(snapshot.docs.map(normalizeHistoryDocument));
    },
    onError,
  );
}

function exportData() {
  const items = [];
  state.itemsBySite.forEach((siteItems) => {
    items.push(...siteItems);
  });
  const details = [];
  state.detailsByItem.forEach((itemDetails) => {
    details.push(...itemDetails);
  });

  return {
    format: 'suivi-materiel-export',
    version: 2,
    exportedAt: nowIso(),
    pages: {
      page1: clone(state.sites),
      page2: clone(items),
      page3: clone(details),
    },
  };
}

function normalizeImportPayload(payload) {
  if (!payload) {
    return null;
  }

  if (payload.pages && typeof payload.pages === 'object') {
    return {
      page1: Array.isArray(payload.pages.page1) ? payload.pages.page1 : [],
      page2: Array.isArray(payload.pages.page2) ? payload.pages.page2 : [],
      page3: Array.isArray(payload.pages.page3) ? payload.pages.page3 : [],
    };
  }

  const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!source) {
    return null;
  }

  const page1 = [];
  const page2 = [];
  const page3 = [];

  source.forEach((site) => {
    const siteId = uid();
    page1.push({
      id: siteId,
      nom: sanitizeText(site.nom, true),
      ownerId: state.userId,
      createdBy: state.userId,
      dateCreation: site.dateCreation || nowIso(),
      dateModification: site.dateModification || site.dateCreation || nowIso(),
      importedAt: nowIso(),
    });

    (site.items || []).forEach((item) => {
      const itemId = uid();
      page2.push({
        id: itemId,
        siteId,
        numero: sanitizeText(item.numero, true),
        ownerId: state.userId,
        createdBy: state.userId,
        dateCreation: item.dateCreation || nowIso(),
        dateModification: item.dateModification || item.dateCreation || nowIso(),
        importedAt: nowIso(),
      });

      (item.details || []).forEach((detail, index) => {
        page3.push({
          id: uid(),
          siteId,
          itemId,
          champ: Number(detail.champ) || index + 1,
          code: sanitizeText(detail.code, true),
          designation: sanitizeText(detail.designation, true),
          qteSortie: sanitizeNumber(detail.qteSortie),
          unite: sanitizeText(detail.unite || 'm', false) || 'm',
          qteHorsBtrs: '',
          qteRetour: sanitizeNumber(detail.qteRetour),
          dateRetour: sanitizeReturnDate(detail.dateRetour),
          qtePosee: sanitizeNumber(detail.qtePosee),
          qteRebus: sanitizeNumber(detail.qteRebus),
          observation: sanitizeText(detail.observation, false),
          statut: sanitizeDetailStatut(detail.statut),
          ownerId: state.userId,
          createdBy: state.userId,
          dateCreation: detail.dateCreation || nowIso(),
          dateModification: detail.dateModification || detail.dateCreation || nowIso(),
          importedAt: nowIso(),
        });
      });
    });
  });

  return { page1, page2, page3 };
}

async function importData(payload) {
  const normalized = normalizeImportPayload(payload);
  if (!normalized) {
    return false;
  }
  const siteIdMap = new Map();
  const itemIdMap = new Map();
  const addedSites = [];
  const addedItems = [];
  const addedDetails = [];

  for (const site of normalized.page1) {
    const localId = sanitizeText(site.id || uid(), false) || uid();
    const sitePayload = { ...site };
    delete sitePayload.id;
    sitePayload.outCount = 0;
    const createdSite = await addDoc(makePageItemsCollection('page1'), sitePayload);
    const nextSite = { id: createdSite.id, ...sitePayload };
    siteIdMap.set(localId, nextSite.id);
    addedSites.push(nextSite);
  }

  for (const item of normalized.page2) {
    const localId = sanitizeText(item.id || uid(), false) || uid();
    const originalSiteId = sanitizeText(item.siteId || '', false);
    const mappedSiteId = siteIdMap.get(originalSiteId) || originalSiteId;
    if (!mappedSiteId) {
      continue;
    }
    const detailCount = normalized.page3.filter((detail) => (siteIdMap.get(sanitizeText(detail.siteId || '', false)) || sanitizeText(detail.siteId || '', false)) === mappedSiteId && sanitizeText(detail.itemId || '', false) === localId).length;
    const itemPayload = { ...item, siteId: mappedSiteId, articleCount: detailCount };
    delete itemPayload.id;
    const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
    const nextItem = { id: createdItem.id, ...itemPayload };
    itemIdMap.set(localId, nextItem.id);
    addedItems.push(nextItem);
  }

  for (const detail of normalized.page3) {
    const originalSiteId = sanitizeText(detail.siteId || '', false);
    const originalItemId = sanitizeText(detail.itemId || '', false);
    const mappedSiteId = siteIdMap.get(originalSiteId) || originalSiteId;
    const mappedItemId = itemIdMap.get(originalItemId) || originalItemId;
    if (!mappedSiteId || !mappedItemId) {
      continue;
    }
    const detailPayload = { ...detail, siteId: mappedSiteId, itemId: mappedItemId };
    delete detailPayload.id;
    const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
    addedDetails.push({ id: createdDetail.id, ...detailPayload });
  }

  state.sites.push(...addedSites);

  addedItems.forEach((item) => {
    if (!state.itemsBySite.has(item.siteId)) {
      state.itemsBySite.set(item.siteId, []);
    }
    state.itemsBySite.get(item.siteId).push(item);
  });

  addedDetails.forEach((detail) => {
    const detailsKey = `${detail.siteId}:${detail.itemId}`;
    if (!state.detailsByItem.has(detailsKey)) {
      state.detailsByItem.set(detailsKey, []);
    }
    state.detailsByItem.get(detailsKey).push(detail);
  });

  await reconcileSiteOutCounts(new Set([...addedSites.map((site) => site.id), ...addedItems.map((item) => item.siteId)]));
  await reconcileItemArticleCounts(new Set([...addedSites.map((site) => site.id), ...addedItems.map((item) => item.siteId)]));
  sortState();
  persistOfflineState();
  emitAll();
  return true;
}

window.StorageService = {
  init,
  getSites,
  getSiteInactivityThresholdDays,
  isSitePendingInactivityDecision,
  refreshSiteInactivityStates,
  listInactiveSitesForCurrentCreator,
  restoreInactiveSite,
  getSite,
  getItem,
  subscribeSites,
  subscribeItems,
  subscribeItemCounts,
  reconcileSiteOutCounts,
  reconcileItemArticleCounts,
  subscribeDetails,
  subscribeDetailCounts,
  subscribeDetailDesignations,
  subscribeDetailRows,
  getDetailRowsBySite,
  getAllDetails,
  getMaterialCodes,
  createSite,
  updateSiteName,
  updateSiteCreator,
  setSiteLock,
  clearSiteLock,
  getSiteUnlockProtectionState,
  registerSiteUnlockFailure,
  resetSiteUnlockProtection,
  setTrashEnabled,
  subscribeTrashSettings,
  subscribeTrashEntries,
  restoreTrashEntry,
  removeSite,
  restoreSite,
  createItem,
  updateItemName,
  removeItem,
  restoreItem,
  createDetail,
  updateDetail,
  addDetailReturn,
  updateDetailReturnQuantity,
  removeDetailReturn,
  removeDetail,
  recordSiteUnlockHistory,
  recordSiteUnlockFailureHistory,
  recordExcelExportHistory,
  exportData,
  importData,
  ensureCurrentUser,
  getCurrentUserProfile,
  saveUsername,
  changeUsername,
  updateAvatarUrl,
  listUsers,
  subscribeUsers,
  listOutCreationPoints,
  subscribeOutCreationPoints,
  updateUserRole,
  updateUserMaintenanceAccess,
  deleteUser,
  cleanupInactiveUsers,
  recordCurrentUserActivity,
  setMaintenanceState,
  subscribeMaintenanceState,
  subscribeCurrentUserProfile,
  computeNextNameChangeDate,
  recordSearchHistory,
  recordFilterHistory,
  recordMaterialsPageOpenHistory,
  listHistoriques,
  subscribeHistoriques,
  getAuthUser: () => clone(state.authUser),
};
