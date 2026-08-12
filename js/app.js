import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseAuth, firebaseDb } from './firebase-core.js';
import { computeEcart, isDetailCompleted, normalizeQuantity, quantitiesAreEqual } from './detail-status.js';
import { getAutomaticUnit } from './automatic-unit.js';

(function () {
  const { StorageService, UiService } = window;

  function requireElement(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const DEFAULT_PURCHASE_IMAGE_SRC = 'Icon/Image.png';

  const EXPORT_FILE_NAME_HISTORY_KEY = 'suiviMateriel.exportFileNames.v1';
  const EXPORT_FILE_NAME_HISTORY_LIMIT = 24;

  function sanitizeExportFileName(value, fallbackName = 'export-materiel') {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || fallbackName;
  }

  function normalizeExportBaseName(value, fallbackName = 'export-materiel') {
    return sanitizeExportFileName(value, fallbackName).replace(/\.xls$/i, '').trim() || fallbackName;
  }

  function sanitizePage2ExportBaseName(value, fallbackName = 'SUIVI_MATERIEL') {
    const cleaned = String(value || '')
      .replace(/\.xlsx?$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/[^\p{L}\p{N}\s._-]+/gu, '')
      .replace(/[.]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned || fallbackName;
  }

  function readExportFileNameHistory() {
    try {
      const rawValue = window.localStorage.getItem(EXPORT_FILE_NAME_HISTORY_KEY);
      if (!rawValue) {
        return [];
      }
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .slice(0, EXPORT_FILE_NAME_HISTORY_LIMIT);
    } catch (_error) {
      return [];
    }
  }

  function saveExportFileNameToHistory(fileName) {
    const normalized = sanitizeExportFileName(fileName);
    const history = readExportFileNameHistory();
    const deduped = [normalized, ...history.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())]
      .slice(0, EXPORT_FILE_NAME_HISTORY_LIMIT);
    try {
      window.localStorage.setItem(EXPORT_FILE_NAME_HISTORY_KEY, JSON.stringify(deduped));
    } catch (_error) {
      // Ignore localStorage restrictions.
    }
  }


  function toFileSlug(value, fallback = 'intelcia-andranomena') {
    const normalized = String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || fallback;
  }

  function buildExportTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}_${hours}-${minutes}`;
  }

  function buildPage2ExportFileName(baseName, extension = 'xlsx') {
    const safeSiteName = sanitizePage2ExportBaseName(baseName);
    const timestamp = buildExportTimestamp();
    return `${safeSiteName}_${timestamp}.${String(extension || 'xlsx').replace(/^\.+/, '')}`;
  }

  function highlightMatchText(text, query) {
    const safeText = String(text || '');
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return escapeHtml(safeText);
    }
    const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
    return escapeHtml(safeText).replace(matcher, '<mark>$1</mark>');
  }


  function normalizeLoggedSearchText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function createSearchAndFilterHistoryLogger(siteId, siteNameResolver) {
    let lastRecordedSearch = '';

    const getContext = () => ({
      siteId,
      siteName: typeof siteNameResolver === 'function' ? siteNameResolver() : siteNameResolver,
    });

    const recordSearch = (searchText) => {
      const normalizedSearch = normalizeLoggedSearchText(searchText);
      if (!normalizedSearch || normalizedSearch === lastRecordedSearch) {
        return;
      }
      lastRecordedSearch = normalizedSearch;
      StorageService.recordSearchHistory?.(normalizedSearch, getContext()).catch(() => {});
    };

    return {
      recordSearchOnBlur(searchText) {
        recordSearch(searchText);
      },
      recordFilter(filterName) {
        const normalizedFilter = normalizeLoggedSearchText(filterName);
        if (!normalizedFilter) {
          return;
        }
        StorageService.recordFilterHistory?.(normalizedFilter, getContext()).catch(() => {});
      },
    };
  }

  function setCountText(element, count, singular, plural) {
    element.textContent = `${count} ${count === 1 ? singular : plural}`;
  }

  function isSiteLocked(site) {
    return Boolean(site?.isLocked) && Boolean(String(site?.passwordHash || '').trim());
  }

  async function hashPassword(value) {
    const normalized = String(value || '');
    const encoded = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function resolveActorLabel(userId, userMap, fallbackName) {
    const directName = String(fallbackName || '').trim();
    if (directName) {
      return directName;
    }
    const username = userMap?.[String(userId || '')];
    return username || 'Utilisateur';
  }

  function resolveSiteLockActorLabel(actorEmail, fallbackName, userMapByEmail) {
    const directName = String(fallbackName || '').trim();
    if (directName) {
      return directName;
    }
    const emailKey = String(actorEmail || '').trim().toLowerCase();
    if (emailKey && userMapByEmail?.[emailKey]) {
      return userMapByEmail[emailKey];
    }
    return 'Utilisateur inconnu';
  }

  function buildDateAndTimeLabel(dateValue) {
    if (!dateValue) {
      return '--';
    }
    let normalizedDateValue = dateValue;
    if (typeof dateValue?.toDate === 'function') {
      normalizedDateValue = dateValue.toDate();
    } else if (dateValue instanceof Date) {
      normalizedDateValue = dateValue;
    } else if (typeof dateValue?.seconds === 'number') {
      normalizedDateValue = new Date(dateValue.seconds * 1000);
    }
    const parsedDate = new Date(normalizedDateValue);
    if (Number.isNaN(parsedDate.getTime())) {
      return '--';
    }
    const dateLabel = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' }).format(parsedDate);
    const timeLabel = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(parsedDate);
    return `${dateLabel} · ${timeLabel}`;
  }

  function startOfDay(date) {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  function parseDateValue(value) {
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

  function itemMatchesDateFilter(item, filterValue) {
    if (!filterValue || filterValue === 'all') {
      return true;
    }

    const itemDate = parseDateValue(item?.dateCreation || item?.dateModification);
    if (!itemDate) {
      return false;
    }

    const today = startOfDay(new Date());
    const itemDay = startOfDay(itemDate);

    if (filterValue === 'today') {
      return itemDay.getTime() === today.getTime();
    }

    if (filterValue === 'yesterday') {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      return itemDay.getTime() === yesterday.getTime();
    }

    if (filterValue === 'lastMonth') {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      return itemDay.getTime() < yesterday.getTime();
    }

    if (filterValue === 'lastYear') {
      return itemDate.getFullYear() === today.getFullYear() - 1;
    }

    return true;
  }

  function resolveItemPeriodLabel(item) {
    const itemDate = parseDateValue(item?.dateCreation || item?.dateModification);
    if (!itemDate) {
      return null;
    }

    const today = startOfDay(new Date());
    const itemDay = startOfDay(itemDate);
    if (itemDay.getTime() === today.getTime()) {
      return "Aujourd'hui";
    }

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (itemDay.getTime() === yesterday.getTime()) {
      return 'Hier';
    }

    if (itemDay.getTime() < yesterday.getTime()) {
      return 'Plus ancien';
    }

    return null;
  }

  function isEmptyQuantityValue(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function formatEditableQuantityValue(value) {
    return isEmptyQuantityValue(value) ? '0' : String(value);
  }

  function normalizeEmptyQuantityInputValue(field) {
    if (field && isEmptyQuantityValue(field.value)) {
      field.value = '0';
    }
  }

  function formatEcartDisplay(value) {
    if (value === '') {
      return '0';
    }

    const numericValue = normalizeQuantity(value);
    if (!Number.isFinite(numericValue)) {
      return '0';
    }

    const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
    if (roundedValue === 0) {
      return '0';
    }

    return roundedValue.toLocaleString('fr-FR', {
      maximumFractionDigits: 2,
    });
  }

  function getEcartNumericValue(field) {
    const rawValue = field?.dataset.ecartValue ?? field?.value ?? 0;
    return normalizeQuantity(rawValue);
  }

  function updateEcartFieldDisplay(field, value) {
    if (!field) {
      return;
    }

    field.dataset.ecartValue = Number.isFinite(value) ? String(value) : '0';
    field.value = formatEcartDisplay(value);
  }

  function formatReturnDate(dateValue) {
    const normalized = String(dateValue || '').trim();
    if (!normalized) {
      return '';
    }
    const [year, month, day] = normalized.split('-');
    if (!year || !month || !day) {
      return '';
    }
    return `${day}/${month}/${year}`;
  }

  function normalizeDetailStatut(value) {
    return String(value || '').trim().toUpperCase() === 'K.O' ? 'K.O' : 'OK';
  }

  function setupZoomableDetailTable() {
    const tableContainer = requireElement('detailTableContainer');
    const tableWrapper = requireElement('detailTableWrapper');
    if (!tableContainer || !tableWrapper) {
      return;
    }

    const minScale = 0.7;
    const maxScale = 2;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let dragState = null;

    function clampScale(value) {
      return Math.min(maxScale, Math.max(minScale, value));
    }

    function applyTransform() {
      tableWrapper.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    function zoomAtPoint(nextScale, clientX, clientY) {
      const clampedScale = clampScale(nextScale);
      if (clampedScale === scale) {
        return;
      }

      const rect = tableContainer.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const nextTranslateX = localX - ((localX - translateX) / scale) * clampedScale;
      const nextTranslateY = localY - ((localY - translateY) / scale) * clampedScale;

      scale = clampedScale;
      translateX = nextTranslateX;
      translateY = nextTranslateY;
      applyTransform();
    }

    function isInteractiveTarget(target) {
      return Boolean(target.closest('input, select, textarea, button, a, label'));
    }

    tableContainer.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const zoomStep = 0.08;
      zoomAtPoint(scale + direction * zoomStep, event.clientX, event.clientY);
    }, { passive: false });

    tableContainer.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) {
        return;
      }
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        startTranslateX: translateX,
        startTranslateY: translateY,
      };
      tableContainer.classList.add('is-grabbing');
      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragState) {
        return;
      }
      translateX = dragState.startTranslateX + (event.clientX - dragState.startX);
      translateY = dragState.startTranslateY + (event.clientY - dragState.startY);
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      dragState = null;
      tableContainer.classList.remove('is-grabbing');
    });

    tableContainer.addEventListener('gesturestart', (event) => {
      event.preventDefault();
    }, { passive: false });

    tableContainer.addEventListener('touchmove', (event) => {
      if (typeof event.scale === 'number' && event.scale !== 1) {
        event.preventDefault();
      }
    }, { passive: false });

    applyTransform();
  }

  function setupBackButtons() {
    document.querySelectorAll('[data-back]').forEach((button) => {
      button.addEventListener('click', () => {
        UiService.navigate(button.dataset.back);
      });
    });
  }

  function waitForAuthState() {
    return new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
        unsubscribe();
        resolve(user || null);
      }, () => resolve(null));
    });
  }

  function normalizeAuthUserData(user) {
    const authUser = user || firebaseAuth.currentUser;
    if (!authUser) {
      return null;
    }
    const photoUrl = String(authUser.photoURL || authUser.photo || '').trim();
    const displayName = String(authUser.displayName || authUser.name || '').trim();
    const email = String(authUser.email || '').trim();
    return {
      uid: authUser.uid || '',
      name: displayName,
      displayName,
      email,
      photoURL: photoUrl,
      photo: photoUrl,
    };
  }

  const GOOGLE_WELCOME_KEY = 'suiviMateriel.googleWelcome.v1';
  const GOOGLE_WELCOME_MAX_AGE_MS = 5 * 60 * 1000;

  function readGoogleWelcomePayload() {
    try {
      const rawPayload = window.sessionStorage.getItem(GOOGLE_WELCOME_KEY);
      if (!rawPayload) {
        return null;
      }
      const payload = JSON.parse(rawPayload);
      const isFresh = Date.now() - Number(payload?.createdAt || 0) <= GOOGLE_WELCOME_MAX_AGE_MS;
      if (payload?.source !== 'google' || !isFresh) {
        window.sessionStorage.removeItem(GOOGLE_WELCOME_KEY);
        return null;
      }
      return payload;
    } catch (_error) {
      window.sessionStorage.removeItem(GOOGLE_WELCOME_KEY);
      return null;
    }
  }

  function resolveWelcomeDisplayName(payload, authUser) {
    const userData = normalizeAuthUserData(authUser);
    const payloadName = String(payload?.displayName || '').trim();
    const authName = String(userData?.displayName || userData?.name || '').trim();
    const emailName = String(payload?.email || userData?.email || '')
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .trim();
    return payloadName || authName || emailName || 'Utilisateur';
  }

  function showGoogleWelcomeOverlay(authUser) {
    const payload = readGoogleWelcomePayload();
    if (!payload) {
      return;
    }

    const overlay = document.getElementById('googleWelcomeOverlay');
    const icon = document.getElementById('googleWelcomeIcon');
    const title = document.getElementById('googleWelcomeTitle');
    const message = document.getElementById('googleWelcomeMessage');
    const button = document.getElementById('googleWelcomeButton');
    if (!overlay || !icon || !title || !message || !button) {
      window.sessionStorage.removeItem(GOOGLE_WELCOME_KEY);
      return;
    }

    const isNewUser = Boolean(payload.isNewUser);
    const displayName = resolveWelcomeDisplayName(payload, authUser);
    const strongName = document.createElement('strong');
    strongName.textContent = displayName;
    const strongAppName = document.createElement('strong');
    strongAppName.textContent = 'Suivi Matériel';

    icon.textContent = isNewUser ? '🎉' : '👋';
    title.textContent = isNewUser ? '🎉 Bienvenue !' : '👋 Heureux de vous revoir !';
    button.textContent = isNewUser ? 'Commencer' : 'OK';
    message.replaceChildren();

    if (isNewUser) {
      const firstLine = document.createElement('p');
      firstLine.append('Bienvenue ', strongName, ' dans ', strongAppName, '.');
      const secondLine = document.createElement('p');
      secondLine.textContent = 'Votre espace a été créé avec succès. Vous pouvez maintenant commencer à enregistrer et gérer vos sites en toute simplicité.';
      message.append(firstLine, secondLine);
    } else {
      const greeting = document.createElement('p');
      greeting.append('Bonjour ', strongName, ',');
      const secondLine = document.createElement('p');
      secondLine.textContent = 'Nous sommes ravis de vous retrouver. Votre espace Suivi Matériel est prêt';
      message.append(greeting, secondLine);
    }

    const closeOverlay = () => {
      overlay.classList.remove('is-visible');
      window.sessionStorage.removeItem(GOOGLE_WELCOME_KEY);
      window.setTimeout(() => {
        overlay.hidden = true;
      }, 180);
    };

    button.onclick = closeOverlay;
    overlay.hidden = false;
    window.requestAnimationFrame(() => {
      overlay.classList.add('is-visible');
      button.focus({ preventScroll: true });
    });
  }

  function renderHomeAccessControls({ authUser, onAvatarClick }) {
    const avatarButton = document.getElementById('userAvatarButton');
    const loginButton = document.getElementById('openLoginButton');
    const userData = normalizeAuthUserData(authUser);
    const isAuthenticated = Boolean(userData);

    setHomeAccessControlVisibility({ showAvatar: false, showLoginButton: false });

    if (isAuthenticated) {
      setHomeAccessControlVisibility({ showAvatar: true, showLoginButton: false });
      renderAvatar(userData, onAvatarClick);
      return;
    }

    if (avatarButton) {
      avatarButton.onclick = null;
    }
    if (loginButton) {
      setHomeAccessControlVisibility({ showAvatar: false, showLoginButton: true });
      loginButton.onclick = () => UiService.navigate('login.html');
    }
  }

  function initAuthRequiredNoticeCard() {
    const cards = Array.from(document.querySelectorAll('[data-auth-required-card]'));
    if (!cards.length) {
      return;
    }

    const loginActions = Array.from(document.querySelectorAll('[data-auth-login-action]'));
    const updateCardVisibility = (user) => {
      const isAuthenticated = Boolean(user?.uid);
      cards.forEach((card) => {
        card.hidden = isAuthenticated;
        card.style.display = isAuthenticated ? 'none' : '';
      });
    };

    loginActions.forEach((actionButton) => {
      actionButton.addEventListener('click', () => {
        UiService.navigate('login.html');
      });
    });

    updateCardVisibility(firebaseAuth.currentUser);
    onAuthStateChanged(firebaseAuth, (user) => {
      updateCardVisibility(user || null);
    });
  }

  function setHomeAccessControlVisibility({ showAvatar, showLoginButton }) {
    const avatarButton = document.getElementById('userAvatarButton');
    const loginButton = document.getElementById('openLoginButton');

    if (avatarButton) {
      avatarButton.hidden = !showAvatar;
      avatarButton.style.display = showAvatar ? 'inline-flex' : 'none';
    }

    if (loginButton) {
      loginButton.hidden = !showLoginButton;
      loginButton.style.display = showLoginButton ? 'inline-flex' : 'none';
    }
  }

  let excelJsModulePromise = null;

  async function getExcelJsModule() {
    if (window.ExcelJS) {
      return window.ExcelJS;
    }
    if (!excelJsModulePromise) {
      excelJsModulePromise = import('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/+esm')
        .then((module) => module.default || module)
        .catch((error) => {
          excelJsModulePromise = null;
          throw error;
        });
    }
    return excelJsModulePromise;
  }

  function computeWrappedRowHeightFromValues(values) {
    const baseHeight = 20;
    const lineHeight = 15;
    const maxLines = values.reduce((max, value) => {
      const raw = String(value || '');
      if (!raw.trim()) {
        return max;
      }
      const manualBreaks = raw.split('\n').length;
      const wrappedLines = Math.ceil(raw.length / 42);
      return Math.max(max, manualBreaks, wrappedLines);
    }, 1);
    return Math.min(120, baseHeight + ((maxLines - 1) * lineHeight));
  }

  async function downloadExcelFile(fileName, title, workbookFactory) {
    try {
      const workbook = await workbookFactory();
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
      UiService.showToast(`${title} lancé.`);
    } catch (error) {
      console.error('Erreur export Excel :', error);
      UiService.showToast('Impossible de générer le fichier Excel.');
    }
  }

  function formatExcelCellValue(value) {
    if (value === null || value === undefined) {
      return '-';
    }
    if (typeof value === 'string' && value.trim() === '') {
      return '-';
    }
    return value;
  }

  function formatExcelHeaderDate(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function applyExcelProfessionalHeader(worksheet, siteName) {
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'SUIVI MATERIEL';
    titleCell.font = { bold: true, size: 12, color: { argb: 'FF374151' } };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };

    const siteCell = worksheet.getCell('A2');
    siteCell.value = `Site concerné : ${siteName || '-'}`;
    siteCell.font = { bold: true, size: 12, color: { argb: 'FF374151' } };
    siteCell.alignment = { horizontal: 'left', vertical: 'middle' };

    const updateCell = worksheet.getCell('A3');
    updateCell.value = `Date de dernière mise à jour : ${formatExcelHeaderDate()}`;
    updateCell.font = { size: 11, color: { argb: 'FF4B5563' } };
    updateCell.alignment = { horizontal: 'left', vertical: 'middle' };

    worksheet.getRow(1).height = 20;
    worksheet.getRow(2).height = 20;
    worksheet.getRow(3).height = 20;
    worksheet.getRow(4).height = 12;
  }

  function applyProfessionalExcelStyling(worksheet, tableStartRow = 1) {
    const centeredColumns = [4, 5, 6, 7, 8, 9, 10, 11, 12];
    const wrappedColumns = [3];
    const statusColumnNumber = 12;
    const koRowFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFD6D6' },
    };
    const headerRow = worksheet.getRow(tableStartRow);

    headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFF3F8' },
    };
    headerRow.height = 24;

    worksheet.eachRow((row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const isCentered = centeredColumns.includes(colNumber);
        cell.alignment = {
          vertical: 'middle',
          horizontal: isCentered ? 'center' : 'left',
          wrapText: wrappedColumns.includes(colNumber),
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });

      if (rowNumber > tableStartRow) {
        const statusValue = String(row.getCell(statusColumnNumber).value || '').trim().toUpperCase();
        if (statusValue === 'K.O') {
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = koRowFill;
          });
        }
        row.height = computeWrappedRowHeightFromValues([row.getCell(3).value, row.getCell(11).value]);
      }
    });

    centeredColumns.forEach((columnNumber) => {
      worksheet.getColumn(columnNumber).eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        if (rowNumber === tableStartRow) {
          return;
        }
        cell.alignment = {
          ...(cell.alignment || {}),
          horizontal: 'center',
          vertical: 'middle',
        };
      });
    });
  }

  function buildDetailExcelContent(title, details, siteName) {
    return async () => {
      const ExcelJS = await getExcelJsModule();
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(String(title || 'Export').slice(0, 31));
      worksheet.columns = [
        { header: '#', key: 'champ', width: 4 },
        { header: 'Code', key: 'code', width: 24 },
        { header: 'Désignation', key: 'designation', width: 56 },
        { header: 'Qté Sortie', key: 'qteSortie', width: 14 },
        { header: 'Unité', key: 'unite', width: 12 },
        { header: 'Qté posée', key: 'qtePosee', width: 14 },
        { header: 'Qté Rebus', key: 'qteRebus', width: 14 },
        { header: 'Qté Retour', key: 'qteRetour', width: 14 },
        { header: 'Date de retour', key: 'dateRetour', width: 14 },
        { header: 'Ecart', key: 'ecart', width: 14 },
        { header: 'Remarque', key: 'observation', width: 16 },
        { header: 'Statut', key: 'statut', width: 14 },
      ];
      details.forEach((detail) => {
        worksheet.addRow({
          champ: formatExcelCellValue(detail.champ),
          code: formatExcelCellValue(detail.code),
          designation: formatExcelCellValue(detail.designation),
          qteSortie: formatExcelCellValue(detail.qteSortie),
          unite: formatExcelCellValue(detail.unite),
          qtePosee: formatExcelCellValue(detail.qtePosee),
          qteRebus: formatExcelCellValue(detail.qteRebus),
          qteRetour: formatExcelCellValue(detail.qteRetour),
          dateRetour: formatExcelCellValue(formatReturnDate(detail.dateRetour)),
          ecart: formatExcelCellValue(computeEcart(detail)),
          observation: formatExcelCellValue(detail.observation),
          statut: formatExcelCellValue(normalizeDetailStatut(detail.statut)),
        });
      });
      worksheet.spliceRows(1, 0, [], [], [], []);
      applyExcelProfessionalHeader(worksheet, siteName);
      applyProfessionalExcelStyling(worksheet, 5);
      return workbook;
    };
  }

  function buildSiteExcelContent(title, rows, siteName) {
    return async () => {
      const ExcelJS = await getExcelJsModule();
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(String(title || 'Export').slice(0, 31));
      worksheet.columns = [
        { header: 'OUT', key: 'out', width: 20 },
        { header: 'Code', key: 'code', width: 24 },
        { header: 'Désignation', key: 'designation', width: 56 },
        { header: 'Qté Sortie', key: 'qteSortie', width: 14 },
        { header: 'Unité', key: 'unite', width: 12 },
        { header: 'Qté posée', key: 'qtePosee', width: 14 },
        { header: 'Qté Rebus', key: 'qteRebus', width: 14 },
        { header: 'Qté Retour', key: 'qteRetour', width: 14 },
        { header: 'Date de retour', key: 'dateRetour', width: 14 },
        { header: 'Ecart', key: 'ecart', width: 14 },
        { header: 'Remarque', key: 'observation', width: 16 },
        { header: 'Statut', key: 'statut', width: 14 },
      ];
      rows.forEach((row) => {
        worksheet.addRow({
          out: formatExcelCellValue(row.out),
          code: formatExcelCellValue(row.code),
          designation: formatExcelCellValue(row.designation),
          qteSortie: formatExcelCellValue(row.qteSortie),
          unite: formatExcelCellValue(row.unite),
          qtePosee: formatExcelCellValue(row.qtePosee),
          qteRebus: formatExcelCellValue(row.qteRebus),
          qteRetour: formatExcelCellValue(row.qteRetour),
          dateRetour: formatExcelCellValue(formatReturnDate(row.dateRetour)),
          ecart: formatExcelCellValue(computeEcart(row)),
          observation: formatExcelCellValue(row.observation),
          statut: formatExcelCellValue(normalizeDetailStatut(row.statut)),
        });
      });
      worksheet.spliceRows(1, 0, [], [], [], []);
      applyExcelProfessionalHeader(worksheet, siteName);
      applyProfessionalExcelStyling(worksheet, 5);
      return workbook;
    };
  }

  function buildMaterialsExcelContent(title, rows, siteName) {
    return async () => {
      const ExcelJS = await getExcelJsModule();
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(String(title || 'Export').slice(0, 31));
      worksheet.columns = [
        { header: 'Code', key: 'code', width: 24 },
        { header: 'Désignation', key: 'designation', width: 56 },
      ];
      rows.forEach((row) => {
        worksheet.addRow({
          code: formatExcelCellValue(row.code),
          designation: formatExcelCellValue(row.designation),
        });
      });
      worksheet.spliceRows(1, 0, [], [], [], []);
      applyExcelProfessionalHeader(worksheet, siteName);
      applyProfessionalExcelStyling(worksheet, 5);
      return workbook;
    };
  }

  window.AppExcelExport = {
    buildPage2ExportFileName,
    buildMaterialsExcelContent,
    buildSiteExcelContent,
    downloadExcelFile,
    saveExportFileNameToHistory,
  };



  function buildPermissions(profile) {
    const username = String(profile?.username || '');
    const role = String(profile?.role || 'limite').trim().toLowerCase();
    const userId = String(profile?.id || '').trim();
    const isAdjointAdmin = role === 'standard' || role === 'adjoint' || role === 'adjoint admin';
    const isAdmin = username === 'Admin' || role === 'admin' || isAdjointAdmin;
    const isStandard = isAdjointAdmin;
    const isLecture = role === 'lecture';
    if (isAdmin) {
      return {
        canCreate: true,
        canEdit: true,
        canDelete: true,
        userId,
        username,
        isAdmin: true,
        isStandard: false,
        canManageUsers: true,
        canImportExport: true,
        isLecture: false,
      };
    }
    return {
      canCreate: true,
      canEdit: true,
      canDelete: true,
      userId,
      username,
      isAdmin: false,
      isStandard,
      canManageUsers: isStandard,
      canImportExport: isStandard,
      isLecture,
    };
  }

  function ensureMaintenanceOverlay() {
    let overlay = document.getElementById('maintenanceOverlay');
    if (overlay) {
      return overlay;
    }
    overlay = document.createElement('div');
    overlay.id = 'maintenanceOverlay';
    overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <article class="maintenance-card" role="alertdialog" aria-modal="true" aria-labelledby="maintenanceTitle">
        <h3 id="maintenanceTitle">Information</h3>
        <p>Page en cours de maintenance, veuillez attendre s'il vous plaît</p>
      </article>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function initMaintenanceGate() {
    // La maintenance globale est affichée en temps réel par js/maintenance-banner.js
    // pour tous les visiteurs, connectés ou non, sans bloquer le contenu existant.
    return () => {};
  }

  function clearClientUserState() {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch (_error) {
      // Ignore storage cleanup errors (private mode / restricted storage).
    }
  }

  function getInitialsFromName(name) {
    const sanitizedName = String(name || '')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim();
    const initials = sanitizedName.substring(0, 2).toUpperCase();
    return initials || 'U';
  }

  function getAvatarFallback(user) {
    const displayName = String(user?.displayName || user?.name || '').trim();
    const emailName = String(user?.email || '').split('@')[0].trim();
    const source = displayName || emailName || 'U';
    return getInitialsFromName(source);
  }

  function renderAvatarVisual(container, { photo, initials, imageClass, altText }) {
    if (!container) {
      return;
    }
    container.innerHTML = photo
      ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(altText)}" class="${imageClass}" />`
      : `<span class="avatar-initials">${escapeHtml(initials)}</span>`;
  }

  function renderUserAvatar(user) {
    const normalizedUser = normalizeAuthUserData(user);
    const photo = String(normalizedUser?.photoURL || '').trim();
    const initials = getAvatarFallback(normalizedUser);
    const headerAvatarElement = document.getElementById('userAvatarButton');
    const bottomSheetAvatarElement = document.getElementById('avatarSheetPreview');

    renderAvatarVisual(headerAvatarElement, {
      photo,
      initials,
      imageClass: 'header-avatar-img',
      altText: 'Avatar',
    });

    renderAvatarVisual(bottomSheetAvatarElement, {
      photo,
      initials,
      imageClass: 'sheet-avatar-img',
      altText: 'Avatar',
    });
  }

  function renderAvatar(authUserData, onClick) {
    const avatarButton = document.getElementById('userAvatarButton');
    if (!avatarButton) {
      return;
    }
    renderUserAvatar(authUserData);
    avatarButton.title = authUserData?.name || authUserData?.email || '';
    setHomeAccessControlVisibility({ showAvatar: true, showLoginButton: false });
    avatarButton.onclick = onClick;
  }

  function ensureAvatarBottomSheet() {
    let overlay = document.getElementById('avatarSheetOverlay');
    if (overlay) {
      return overlay;
    }

    overlay = document.createElement('div');
    overlay.id = 'avatarSheetOverlay';
    overlay.className = 'bottom-sheet-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="bottom-sheet" id="avatarBottomSheet" role="dialog" aria-modal="true" aria-label="Actions du profil">
        <div class="bottom-sheet__handle" aria-hidden="true"></div>
        <div class="bottom-sheet__content">
          <div class="bottom-sheet__avatar-wrap">
            <div class="bottom-sheet__avatar" id="avatarSheetPreview">U</div>
          </div>
          <p class="bottom-sheet__name" id="avatarSheetName">Utilisateur</p>
          <p class="bottom-sheet__email" id="avatarSheetEmail"></p>
          <button type="button" class="bottom-sheet__action" id="avatarSheetLogout">
            <img src="Icon/se-deconnecter.png" alt="" class="bottom-sheet__action-icon" aria-hidden="true">
            <span>Déconnexion</span>
          </button>
          <p id="avatarSheetMessage" class="form-error" aria-live="polite"></p>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function ensureLogoutConfirmationCard() {
    let overlay = document.getElementById('logoutConfirmOverlay');
    if (overlay) {
      return overlay;
    }

    overlay = document.createElement('div');
    overlay.id = 'logoutConfirmOverlay';
    overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <article class="maintenance-card item-delete-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="logoutConfirmTitle">
        <h3 id="logoutConfirmTitle">Déconnexion</h3>
        <p>Voulez-vous vous déconnecter ?</p>
        <div class="modal-actions item-delete-confirm-actions">
          <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--cancel" id="logoutConfirmCancel">Annuler</button>
          <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--danger" id="logoutConfirmSubmit">Déconnexion</button>
        </div>
      </article>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function askLogoutConfirmation() {
    const overlay = ensureLogoutConfirmationCard();
    const cancelButton = overlay.querySelector('#logoutConfirmCancel');
    const submitButton = overlay.querySelector('#logoutConfirmSubmit');
    if (!cancelButton || !submitButton) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const closeAnimationDurationMs = 170;
      let closeAnimationTimer = null;
      let isClosing = false;
      const cleanup = () => {
        if (closeAnimationTimer) {
          window.clearTimeout(closeAnimationTimer);
          closeAnimationTimer = null;
        }
        overlay.hidden = true;
        overlay.classList.remove('is-open');
        overlay.onclick = null;
        cancelButton.onclick = null;
        submitButton.onclick = null;
        document.removeEventListener('keydown', handleKeyDown);
      };
      const close = (value) => {
        if (isClosing) {
          return;
        }
        isClosing = true;
        overlay.classList.remove('is-open');
        closeAnimationTimer = window.setTimeout(() => {
          cleanup();
          resolve(value);
        }, closeAnimationDurationMs);
      };
      const handleKeyDown = (event) => {
        if (event.key === 'Escape') {
          close(false);
        }
      };

      cancelButton.onclick = () => close(false);
      submitButton.onclick = () => close(true);
      overlay.onclick = (event) => {
        if (event.target === overlay) {
          close(false);
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      overlay.hidden = false;
      window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
      });
    });
  }

  function openAvatarBottomSheet(authUserData) {
    const overlay = ensureAvatarBottomSheet();
    const sheet = overlay.querySelector('#avatarBottomSheet');
    const avatarPreview = overlay.querySelector('#avatarSheetPreview');
    const nameLabel = overlay.querySelector('#avatarSheetName');
    const emailLabel = overlay.querySelector('#avatarSheetEmail');
    const logoutButton = overlay.querySelector('#avatarSheetLogout');
    const message = overlay.querySelector('#avatarSheetMessage');

    if (!sheet || !avatarPreview || !nameLabel || !emailLabel || !logoutButton || !message) {
      return;
    }

    renderUserAvatar(authUserData);
    nameLabel.textContent = String(authUserData?.name || authUserData?.email || 'Utilisateur');
    emailLabel.textContent = String(authUserData?.email || '');
    avatarPreview.title = authUserData?.name || authUserData?.email || '';
    message.textContent = '';

    const closeTransitionDurationMs = 320;
    const clearCloseListeners = () => {
      if (overlay.__closeTimerId) {
        window.clearTimeout(overlay.__closeTimerId);
        overlay.__closeTimerId = null;
      }
      if (overlay.__closeTransitionHandler) {
        overlay.removeEventListener('transitionend', overlay.__closeTransitionHandler);
        overlay.__closeTransitionHandler = null;
      }
    };
    const finalizeClose = () => {
      clearCloseListeners();
      overlay.hidden = true;
      overlay.classList.remove('is-open');
    };
    const closeSheet = () =>
      new Promise((resolve) => {
        if (overlay.hidden) {
          resolve();
          return;
        }

        let isResolved = false;
        const finish = () => {
          if (isResolved) {
            return;
          }
          isResolved = true;
          finalizeClose();
          resolve();
        };

        overlay.classList.remove('is-open');
        overlay.__closeTransitionHandler = (event) => {
          if (event.target !== overlay && event.target !== sheet) {
            return;
          }
          finish();
        };
        overlay.addEventListener('transitionend', overlay.__closeTransitionHandler);
        overlay.__closeTimerId = window.setTimeout(finish, closeTransitionDurationMs);
      });

    logoutButton.onclick = async () => {
      await closeSheet();
      const shouldLogout = await askLogoutConfirmation();
      if (!shouldLogout) {
        return;
      }
      try {
        await StorageService?.recordCurrentUserActivity?.();
        await signOut(firebaseAuth);
      } catch (_error) {
        message.textContent = "Impossible de se déconnecter pour l'instant.";
      }
    };

    overlay.onclick = (event) => {
      if (event.target === overlay) {
        closeSheet();
      }
    };

    let touchStartY = null;
    sheet.ontouchstart = (event) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    sheet.ontouchend = (event) => {
      if (touchStartY === null) {
        return;
      }
      const touchEndY = event.changedTouches[0]?.clientY ?? touchStartY;
      if (touchEndY - touchStartY > 60) {
        closeSheet();
      }
      touchStartY = null;
    };

    overlay.hidden = false;
    clearCloseListeners();
    window.requestAnimationFrame(() => {
      overlay.classList.add('is-open');
    });
  }

  function initHomePage(permissions, authState) {
    initAuthRequiredNoticeCard();

    const searchInput = requireElement('searchInput');
    const siteList = requireElement('siteList');
    const siteCount = requireElement('siteCount');
    const siteDialog = requireElement('siteDialog');
    const siteForm = requireElement('siteForm');
    const siteNameInput = requireElement('siteNameInput');
    const siteNameCounter = requireElement('siteNameCounter');
    const siteFormError = requireElement('siteFormError');
    const siteCreateSubmitButton = requireElement('siteCreateSubmitButton');
    const siteEditNameDialog = requireElement('siteEditNameDialog');
    const siteEditNameForm = requireElement('siteEditNameForm');
    const siteEditNameInput = requireElement('siteEditNameInput');
    const siteEditNameCounter = requireElement('siteEditNameCounter');
    const siteEditNameError = requireElement('siteEditNameError');
    const siteEditNameSubmitButton = requireElement('siteEditNameSubmitButton');
    const homeMenuButton = requireElement('homeMenuButton');
    const homeMenuPanel = requireElement('homeMenuPanel');
    const homeMenuOverlay = requireElement('homeMenuOverlay');
    const importDataButton = requireElement('sidebarImportBtn');
    const exportDataButton = requireElement('sidebarExportBtn');
    const manageUsersButton = requireElement('sidebarUsersBtn');
    const usersSidebarBtn = homeMenuPanel?.querySelector('#sidebarUsersBtn') || null;
    const historySidebarBtn = homeMenuPanel?.querySelector('#sidebarHistoryBtn') || null;
    const allMaterialsSidebarBtn = homeMenuPanel?.querySelector('#sidebarAllMaterialsBtn') || null;
    const indemnitiesSidebarBtn = homeMenuPanel?.querySelector('#sidebarIndemnitiesBtn') || null;
    const sidebarItems = homeMenuPanel ? Array.from(homeMenuPanel.querySelectorAll('.sidebar-item')) : [];
    const siteLockDialog = requireElement('siteLockDialog');
    const siteLockForm = requireElement('siteLockForm');
    const siteLockPasswordInput = requireElement('siteLockPasswordInput');
    const siteLockConfirmPasswordInput = requireElement('siteLockConfirmPasswordInput');
    const siteLockPasswordError = requireElement('siteLockPasswordError');
    const siteLockConfirmPasswordError = requireElement('siteLockConfirmPasswordError');
    const siteLockStrengthIndicator = requireElement('siteLockStrengthIndicator');
    const siteLockStrengthLabel = requireElement('siteLockStrengthLabel');
    const siteLockStatusDialog = requireElement('siteLockStatusDialog');
    const siteLockStatusMessage = requireElement('siteLockStatusMessage');
    const siteLockStatusCloseButton = requireElement('siteLockStatusCloseButton');
    const siteUnlockDialog = requireElement('siteUnlockDialog');
    const siteUnlockForm = requireElement('siteUnlockForm');
    const siteUnlockPasswordInput = requireElement('siteUnlockPasswordInput');
    const siteUnlockPasswordToggle = requireElement('siteUnlockPasswordToggle');
    const siteUnlockSubmitButton = requireElement('siteUnlockSubmitButton');
    const siteUnlockAttemptsInfo = requireElement('siteUnlockAttemptsInfo');
    const siteUnlockError = requireElement('siteUnlockError');
    const siteLockManageDialog = requireElement('siteLockManageDialog');
    const siteLockManageForm = requireElement('siteLockManageForm');
    const siteLockCurrentPasswordInput = requireElement('siteLockCurrentPasswordInput');
    const siteLockNewPasswordInput = requireElement('siteLockNewPasswordInput');
    const siteLockCurrentPasswordError = requireElement('siteLockCurrentPasswordError');
    const siteLockManageAttemptsInfo = requireElement('siteLockManageAttemptsInfo');
    const siteLockNewPasswordError = requireElement('siteLockNewPasswordError');
    const siteLockCurrentPasswordToggle = requireElement('siteLockCurrentPasswordToggle');
    const siteLockNewPasswordToggle = requireElement('siteLockNewPasswordToggle');
    const siteLockManageUpdateButton = requireElement('siteLockManageUpdateButton');
    const siteLockManageUnlockButton = requireElement('siteLockManageUnlockButton');

    let currentSites = [];
    let itemCountsBySite = {};
    let userNamesById = {};
    let userNamesByEmail = {};
    let userEmailsById = {};
    let activeUsers = [];
    let currentPermissions = permissions;
    let isAuthenticated = Boolean(authState?.isAuthenticated);
    let siteIdPendingLock = null;
    let siteIdPendingUnlock = null;
    let siteIdPendingLockManage = null;
    const siteActionState = {
      activeSiteId: null,
      closeSheet: null,
      refreshSheetContent: null,
      closeConfirmation: null,
      hasHistoryEntry: false,
      ignoreNextPopstate: false,
    };
    const transientErrorTimers = new WeakMap();
    let isSiteCreationPending = false;
    let siteNameErrorClearTimer = null;
    let siteNameEditErrorClearTimer = null;
    let isSiteNameEditPending = false;
    let siteNameAvailabilityDebounceTimer = null;
    let isSiteCreateInputValid = false;
    const siteNameCollator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
    const siteLockFieldStateTimers = new WeakMap();

    function compareSitesByName(siteA, siteB) {
      return siteNameCollator.compare(String(siteA?.nom || ''), String(siteB?.nom || ''));
    }
    let isSiteUnlockPending = false;
    let siteUnlockBlockTimer = null;
    let siteUnlockCountdownTimer = null;
    let siteLockManageBlockTimer = null;
    let siteLockManageCountdownTimer = null;
    let isSiteLockManageBlocked = false;
    let isSiteLockManageUpdatePending = false;
    let isSiteLockManageUnlockPending = false;

    function setSiteCreateLoadingState(isLoading) {
      isSiteCreationPending = Boolean(isLoading);
      if (!siteCreateSubmitButton) {
        return;
      }
      siteCreateSubmitButton.disabled = isSiteCreationPending || !isSiteCreateInputValid;
      siteCreateSubmitButton.classList.toggle('is-loading', isSiteCreationPending);
      siteCreateSubmitButton.setAttribute('aria-busy', String(isSiteCreationPending));
    }

    function getSiteNameMaxLength() {
      return siteNameInput.maxLength > 0 ? siteNameInput.maxLength : null;
    }

    function getSiteEditNameMaxLength() {
      return siteEditNameInput?.maxLength > 0 ? siteEditNameInput.maxLength : 25;
    }

    function setSiteUnlockLoadingState(isLoading) {
      isSiteUnlockPending = Boolean(isLoading);
      if (!siteUnlockSubmitButton) {
        return;
      }
      siteUnlockSubmitButton.disabled = isSiteUnlockPending || Boolean(siteUnlockSubmitButton.dataset.blocked === 'true');
      siteUnlockSubmitButton.classList.toggle('is-loading', isSiteUnlockPending);
      siteUnlockSubmitButton.setAttribute('aria-busy', String(isSiteUnlockPending));
    }

    function setSiteLockManageActionLoadingState(action, isLoading) {
      if (action === 'unlock') {
        isSiteLockManageUnlockPending = Boolean(isLoading);
        if (!siteLockManageUnlockButton) {
          return;
        }
        siteLockManageUnlockButton.disabled = isSiteLockManageUnlockPending || isSiteLockManageBlocked;
        siteLockManageUnlockButton.classList.toggle('is-loading', isSiteLockManageUnlockPending);
        siteLockManageUnlockButton.setAttribute('aria-busy', String(isSiteLockManageUnlockPending));
        return;
      }
      isSiteLockManageUpdatePending = Boolean(isLoading);
      if (!siteLockManageUpdateButton) {
        return;
      }
      siteLockManageUpdateButton.disabled = isSiteLockManageUpdatePending || isSiteLockManageBlocked;
      siteLockManageUpdateButton.classList.toggle('is-loading', isSiteLockManageUpdatePending);
      siteLockManageUpdateButton.setAttribute('aria-busy', String(isSiteLockManageUpdatePending));
    }

    function enforceSiteNameMaxLength() {
      const maxLength = getSiteNameMaxLength();
      if (!maxLength || maxLength <= 0) {
        return;
      }
      if (siteNameInput.value.length > maxLength) {
        siteNameInput.value = siteNameInput.value.slice(0, maxLength);
      }
    }

    function updateSiteNameCounter() {
      enforceSiteNameMaxLength();
      const maxLength = getSiteNameMaxLength();
      const currentLength = siteNameInput.value.length;
      siteNameCounter.textContent = `${currentLength} / ${maxLength ?? currentLength}`;

      siteNameCounter.classList.remove('is-warning', 'is-limit');
      if (!maxLength || maxLength <= 0) {
        return;
      }

      const ratio = currentLength / maxLength;
      if (ratio >= 1) {
        siteNameCounter.classList.add('is-limit');
      } else if (ratio >= 0.8) {
        siteNameCounter.classList.add('is-warning');
      }
    }

    function updateSiteEditNameCounter() {
      if (!siteEditNameInput || !siteEditNameCounter) {
        return;
      }
      const maxLength = getSiteEditNameMaxLength();
      if (siteEditNameInput.value.length > maxLength) {
        siteEditNameInput.value = siteEditNameInput.value.slice(0, maxLength);
      }
      const currentLength = siteEditNameInput.value.length;
      siteEditNameCounter.textContent = `${currentLength} / ${maxLength}`;
      siteEditNameCounter.classList.remove('is-warning', 'is-limit');
      const ratio = currentLength / maxLength;
      if (ratio >= 1) {
        siteEditNameCounter.classList.add('is-limit');
      } else if (ratio >= 0.8) {
        siteEditNameCounter.classList.add('is-warning');
      }
    }

    function clearTransientError(errorElement) {
      if (!errorElement) {
        return;
      }
      const activeTimer = transientErrorTimers.get(errorElement);
      if (activeTimer) {
        window.clearTimeout(activeTimer);
        transientErrorTimers.delete(errorElement);
      }
      errorElement.textContent = '';
    }

    function clearSiteNameErrorState() {
      if (siteNameErrorClearTimer) {
        window.clearTimeout(siteNameErrorClearTimer);
        siteNameErrorClearTimer = null;
      }
      siteNameInput.classList.remove('is-error', 'is-shaking');
    }

    function showSiteNameError(message, durationMs = 2300) {
      clearSiteNameErrorState();
      showTransientError(siteFormError, message);
      siteNameInput.classList.remove('is-shaking');
      // Force un reflow pour rejouer l'animation à chaque nouvelle erreur.
      void siteNameInput.offsetWidth;
      siteNameInput.classList.add('is-error', 'is-shaking');
      siteNameErrorClearTimer = window.setTimeout(() => {
        clearSiteNameErrorState();
      }, durationMs);
    }

    function setSiteCreateSubmitEnabled(isEnabled) {
      if (!siteCreateSubmitButton) {
        return;
      }
      isSiteCreateInputValid = Boolean(isEnabled);
      siteCreateSubmitButton.disabled = isSiteCreationPending;
    }

    function clearSiteNameAvailabilityMessage() {
      clearTransientError(siteFormError);
      siteFormError.style.color = '';
      clearSiteNameErrorState();
    }

    function showSiteNameAvailabilityError(message) {
      clearSiteNameErrorState();
      siteNameInput.classList.add('is-error');
      siteFormError.textContent = message;
      siteFormError.style.color = '';
    }

    function showSiteNameAvailabilitySuccess(message) {
      clearSiteNameErrorState();
      siteFormError.textContent = message;
      siteFormError.style.color = 'var(--success)';
    }

    function isSiteNameAlreadyUsed(normalizedName) {
      return currentSites.some((site) => String(site?.name || site?.nom || '').trim().toLowerCase() === normalizedName);
    }

    function validateSiteNameDuringInput() {
      const value = siteNameInput.value.trim();
      const normalizedValue = value.toLowerCase();

      if (!value) {
        clearSiteNameAvailabilityMessage();
        setSiteCreateSubmitEnabled(false);
        return;
      }

      if (value.length < 4) {
        showSiteNameAvailabilityError('Le nom doit contenir au moins 4 caractères.');
        setSiteCreateSubmitEnabled(false);
        return;
      }

      if (isSiteNameAlreadyUsed(normalizedValue)) {
        showSiteNameAvailabilityError('Ce nom de site existe déjà.');
        setSiteCreateSubmitEnabled(false);
        return;
      }

      showSiteNameAvailabilitySuccess('Ce nom de site est disponible.');
      setSiteCreateSubmitEnabled(Boolean(currentPermissions.canCreate) && !isSiteCreationPending);
    }

    function clearSiteEditNameErrorState() {
      if (siteNameEditErrorClearTimer) {
        window.clearTimeout(siteNameEditErrorClearTimer);
        siteNameEditErrorClearTimer = null;
      }
      siteEditNameInput?.classList.remove('input-error', 'is-error', 'is-shaking');
    }

    function showSiteEditNameError(message, durationMs = 2300) {
      clearSiteEditNameErrorState();
      showTransientError(siteEditNameError, message);
      siteEditNameInput?.classList.remove('is-shaking');
      void siteEditNameInput?.offsetWidth;
      siteEditNameInput?.classList.add('input-error', 'is-error', 'is-shaking');
      siteNameEditErrorClearTimer = window.setTimeout(() => {
        clearSiteEditNameErrorState();
      }, durationMs);
    }

    function setSiteEditNameLoadingState(isLoading) {
      isSiteNameEditPending = Boolean(isLoading);
      if (!siteEditNameSubmitButton) {
        return;
      }
      siteEditNameSubmitButton.disabled = isSiteNameEditPending;
    }

    function showTransientError(errorElement, message) {
      if (!errorElement) {
        return;
      }
      clearTransientError(errorElement);
      errorElement.textContent = message;
      const hideTimer = window.setTimeout(() => {
        errorElement.textContent = '';
        transientErrorTimers.delete(errorElement);
      }, 2000);
      transientErrorTimers.set(errorElement, hideTimer);
    }

    function clearSiteLockFieldErrorState(inputElement, errorElement) {
      if (!inputElement || !errorElement) {
        return;
      }
      clearTransientError(errorElement);
      const timer = siteLockFieldStateTimers.get(inputElement);
      if (timer) {
        window.clearTimeout(timer);
        siteLockFieldStateTimers.delete(inputElement);
      }
      inputElement.classList.remove('is-error', 'is-shaking');
    }

    function showSiteLockFieldError(inputElement, errorElement, message, durationMs = 2300) {
      if (!inputElement || !errorElement) {
        return;
      }
      clearSiteLockFieldErrorState(inputElement, errorElement);
      showTransientError(errorElement, message);
      inputElement.classList.remove('is-shaking');
      void inputElement.offsetWidth;
      inputElement.classList.add('is-error', 'is-shaking');
      const timer = window.setTimeout(() => {
        inputElement.classList.remove('is-error', 'is-shaking');
        siteLockFieldStateTimers.delete(inputElement);
      }, durationMs);
      siteLockFieldStateTimers.set(inputElement, timer);
    }

    function clearSiteLockManageFieldErrorState(inputElement, errorElement) {
      clearSiteLockFieldErrorState(inputElement, errorElement);
    }

    function showSiteLockManageFieldError(inputElement, errorElement, message, durationMs = 2300) {
      showSiteLockFieldError(inputElement, errorElement, message, durationMs);
    }

    function clearSiteLockManageErrors() {
      clearSiteLockManageFieldErrorState(siteLockCurrentPasswordInput, siteLockCurrentPasswordError);
      clearSiteLockManageFieldErrorState(siteLockNewPasswordInput, siteLockNewPasswordError);
    }

    function clearSiteLockManageLoadingStates() {
      setSiteLockManageActionLoadingState('update', false);
      setSiteLockManageActionLoadingState('unlock', false);
    }

    function setSiteLockManageBlockedState(isBlocked) {
      isSiteLockManageBlocked = Boolean(isBlocked);
      if (siteLockCurrentPasswordInput) {
        siteLockCurrentPasswordInput.disabled = isSiteLockManageBlocked;
      }
      if (siteLockCurrentPasswordToggle) {
        siteLockCurrentPasswordToggle.disabled = isSiteLockManageBlocked;
      }
      setSiteLockManageActionLoadingState('update', isSiteLockManageUpdatePending);
      setSiteLockManageActionLoadingState('unlock', isSiteLockManageUnlockPending);
    }

    function clearSiteLockManageAttemptsInfo() {
      if (!siteLockManageAttemptsInfo) {
        return;
      }
      siteLockManageAttemptsInfo.textContent = '';
      siteLockManageAttemptsInfo.hidden = true;
      siteLockManageAttemptsInfo.classList.remove('form-info--blocked');
    }

    function updateSiteLockManageCountdownMessage(siteId, blockedUntil) {
      const message = formatSiteUnlockCountdown(blockedUntil);
      if (!message) {
        clearSiteLockManageAttemptsInfo();
        setSiteLockManageBlockedState(false);
        if (siteIdPendingLockManage === siteId && siteLockManageDialog?.open) {
          refreshSiteLockManageProtectionState(siteId);
        }
        return;
      }
      if (siteLockManageAttemptsInfo) {
        siteLockManageAttemptsInfo.textContent = message;
        siteLockManageAttemptsInfo.hidden = false;
        siteLockManageAttemptsInfo.classList.add('form-info--blocked');
      }
    }

    function clearSiteLockManageBlockTimer() {
      if (siteLockManageBlockTimer) {
        window.clearTimeout(siteLockManageBlockTimer);
        siteLockManageBlockTimer = null;
      }
      if (siteLockManageCountdownTimer) {
        window.clearInterval(siteLockManageCountdownTimer);
        siteLockManageCountdownTimer = null;
      }
    }

    function scheduleSiteLockManageUnblock(siteId, blockedUntil) {
      clearSiteLockManageBlockTimer();
      const unblockAt = new Date(blockedUntil || '').getTime();
      const delayMs = unblockAt - Date.now();
      if (!Number.isFinite(delayMs) || delayMs <= 0) {
        return;
      }
      updateSiteLockManageCountdownMessage(siteId, blockedUntil);
      siteLockManageCountdownTimer = window.setInterval(() => {
        updateSiteLockManageCountdownMessage(siteId, blockedUntil);
      }, 60 * 1000);
      siteLockManageBlockTimer = window.setTimeout(() => {
        if (siteIdPendingLockManage === siteId && siteLockManageDialog?.open) {
          refreshSiteLockManageProtectionState(siteId);
        }
      }, Math.min(delayMs, 24 * 60 * 60 * 1000));
    }

    async function refreshSiteLockManageProtectionState(siteId) {
      const protection = await StorageService.getSiteUnlockProtectionState(siteId);
      if (!protection?.ok) {
        return null;
      }
      clearSiteLockManageAttemptsInfo();
      setSiteLockManageBlockedState(protection.isBlocked);
      if (protection.isBlocked) {
        clearSiteLockManageFieldErrorState(siteLockCurrentPasswordInput, siteLockCurrentPasswordError);
        scheduleSiteLockManageUnblock(siteId, protection.blockedUntil);
      } else {
        clearSiteLockManageBlockTimer();
      }
      return protection;
    }

    function clearSiteUnlockFieldErrorState() {
      if (!siteUnlockPasswordInput || !siteUnlockError) {
        return;
      }
      clearTransientError(siteUnlockError);
      const timer = siteLockFieldStateTimers.get(siteUnlockPasswordInput);
      if (timer) {
        window.clearTimeout(timer);
        siteLockFieldStateTimers.delete(siteUnlockPasswordInput);
      }
      siteUnlockPasswordInput.classList.remove('is-error', 'is-shaking');
    }

    function showSiteUnlockFieldError(message, durationMs = 2300) {
      if (!siteUnlockPasswordInput || !siteUnlockError) {
        return;
      }
      clearSiteUnlockFieldErrorState();
      showTransientError(siteUnlockError, message);
      siteUnlockPasswordInput.classList.remove('is-shaking');
      void siteUnlockPasswordInput.offsetWidth;
      siteUnlockPasswordInput.classList.add('is-error', 'is-shaking');
      const timer = window.setTimeout(() => {
        siteUnlockPasswordInput.classList.remove('is-error', 'is-shaking');
        siteLockFieldStateTimers.delete(siteUnlockPasswordInput);
      }, durationMs);
      siteLockFieldStateTimers.set(siteUnlockPasswordInput, timer);
    }

    function formatAttemptsRemainingMessage(attemptsRemaining) {
      const count = Math.max(0, Number(attemptsRemaining) || 0);
      return `Il vous reste ${count} ${count === 1 ? 'tentative' : 'tentatives'}.`;
    }

    function setSiteUnlockBlockedState(isBlocked) {
      if (siteUnlockPasswordInput) {
        siteUnlockPasswordInput.disabled = Boolean(isBlocked);
      }
      if (siteUnlockPasswordToggle) {
        siteUnlockPasswordToggle.disabled = Boolean(isBlocked);
      }
      if (siteUnlockSubmitButton) {
        siteUnlockSubmitButton.dataset.blocked = String(Boolean(isBlocked));
        siteUnlockSubmitButton.disabled = Boolean(isBlocked) || isSiteUnlockPending;
      }
    }

    function clearSiteUnlockAttemptsInfo() {
      if (!siteUnlockAttemptsInfo) {
        return;
      }
      siteUnlockAttemptsInfo.textContent = '';
      siteUnlockAttemptsInfo.hidden = true;
      siteUnlockAttemptsInfo.classList.remove('form-info--blocked');
    }

    function formatSiteUnlockCountdown(blockedUntil) {
      const unblockDate = new Date(blockedUntil || '');
      const unblockAt = unblockDate.getTime();
      const remainingMs = unblockAt - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        return '';
      }
      const weekday = unblockDate.toLocaleDateString('fr-FR', { weekday: 'long' });
      const date = unblockDate.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      const time = unblockDate.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).replace(':', ' h ');
      return `Vous pourrez réessayer demain << ${weekday}  ${date}  à  ${time} >>.`;
    }

    function updateSiteUnlockCountdownMessage(siteId, blockedUntil) {
      const message = formatSiteUnlockCountdown(blockedUntil);
      if (!message) {
        clearSiteUnlockAttemptsInfo();
        setSiteUnlockBlockedState(false);
        if (siteIdPendingUnlock === siteId && siteUnlockDialog?.open) {
          refreshSiteUnlockProtectionState(siteId);
        }
        return;
      }
      if (siteUnlockAttemptsInfo) {
        siteUnlockAttemptsInfo.textContent = message;
        siteUnlockAttemptsInfo.hidden = false;
        siteUnlockAttemptsInfo.classList.add('form-info--blocked');
      }
    }

    function clearSiteUnlockBlockTimer() {
      if (siteUnlockBlockTimer) {
        window.clearTimeout(siteUnlockBlockTimer);
        siteUnlockBlockTimer = null;
      }
      if (siteUnlockCountdownTimer) {
        window.clearInterval(siteUnlockCountdownTimer);
        siteUnlockCountdownTimer = null;
      }
    }

    function scheduleSiteUnlockUnblock(siteId, blockedUntil) {
      clearSiteUnlockBlockTimer();
      const unblockAt = new Date(blockedUntil || '').getTime();
      const delayMs = unblockAt - Date.now();
      if (!Number.isFinite(delayMs) || delayMs <= 0) {
        return;
      }
      updateSiteUnlockCountdownMessage(siteId, blockedUntil);
      siteUnlockCountdownTimer = window.setInterval(() => {
        updateSiteUnlockCountdownMessage(siteId, blockedUntil);
      }, 60 * 1000);
      siteUnlockBlockTimer = window.setTimeout(() => {
        if (siteIdPendingUnlock === siteId && siteUnlockDialog?.open) {
          refreshSiteUnlockProtectionState(siteId);
        }
      }, Math.min(delayMs, 24 * 60 * 60 * 1000));
    }

    async function refreshSiteUnlockProtectionState(siteId) {
      const protection = await StorageService.getSiteUnlockProtectionState(siteId);
      if (!protection?.ok) {
        return null;
      }
      clearSiteUnlockAttemptsInfo();
      setSiteUnlockBlockedState(protection.isBlocked);
      if (protection.isBlocked) {
        clearSiteUnlockFieldErrorState();
        scheduleSiteUnlockUnblock(siteId, protection.blockedUntil);
      } else {
        clearSiteUnlockBlockTimer();
      }
      return protection;
    }

    function setPasswordVisibility(inputElement, toggleButton, isVisible) {
      if (!inputElement || !toggleButton) {
        return;
      }
      const iconElement = toggleButton.querySelector('img');
      inputElement.type = isVisible ? 'text' : 'password';
      toggleButton.setAttribute('aria-label', isVisible ? 'Cacher le mot de passe' : 'Afficher le mot de passe');
      if (iconElement) {
        iconElement.src = isVisible ? 'Icon/Eye_ON.png' : 'Icon/Eye_OFF.png';
      }
    }

    function getPasswordStrength(passwordValue) {
      const value = String(passwordValue || '');
      const length = value.length;
      if (!length) {
        return null;
      }
      const bonusCount = [/[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
      if (length < 6) {
        return 'weak';
      }
      if (length >= 10 && bonusCount >= 2) {
        return 'strong';
      }
      if ((length >= 6 && length <= 9) || bonusCount >= 1) {
        return 'medium';
      }
      return 'weak';
    }

    function canCurrentUserChangeSiteCreator() {
      return Boolean(currentPermissions?.isAdmin);
    }

    function getActiveCreatorUsers() {
      return activeUsers.filter((user) => String(user?.id || '').trim() && String(user?.username || user?.displayName || user?.name || user?.email || '').trim());
    }

    function updateSiteLockStrengthIndicator() {
      if (!siteLockStrengthIndicator || !siteLockStrengthLabel) {
        return;
      }
      const passwordValue = siteLockPasswordInput?.value || '';
      const strength = getPasswordStrength(passwordValue);
      if (!strength) {
        siteLockStrengthIndicator.hidden = true;
        siteLockStrengthIndicator.removeAttribute('data-strength');
        return;
      }
      const strengthLabelByKey = {
        weak: 'Mot de passe faible',
        medium: 'Mot de passe moyen',
        strong: 'Mot de passe fort',
      };
      siteLockStrengthIndicator.hidden = false;
      siteLockStrengthIndicator.dataset.strength = strength;
      siteLockStrengthLabel.textContent = strengthLabelByKey[strength] || strengthLabelByKey.weak;
    }

    async function loadUserNames() {
      try {
        const users = await StorageService.listUsers();
        activeUsers = users;
        userNamesById = users.reduce((accumulator, user) => {
          if (user?.id) {
            accumulator[user.id] = user.username || user.displayName || user.name || 'Utilisateur';
          }
          return accumulator;
        }, {});
        userNamesByEmail = users.reduce((accumulator, user) => {
          const email = String(user?.email || '').trim().toLowerCase();
          const displayName = String(user?.displayName || user?.rawUsername || user?.name || '').trim();
          if (email && displayName) {
            accumulator[email] = displayName;
          }
          return accumulator;
        }, {});
        userEmailsById = users.reduce((accumulator, user) => {
          const email = String(user?.email || '').trim();
          if (user?.id && email) {
            accumulator[user.id] = email;
          }
          return accumulator;
        }, {});
      } catch (_error) {
        userNamesById = {};
        userNamesByEmail = {};
        userEmailsById = {};
        activeUsers = [];
      }
      renderSites();
    }

    function formatExportFileName() {
      const now = new Date();
      const datePart = now.toISOString().replace(/[:]/g, '-').replace(/\..+/, '').replace('T', '_');
      return `Exporter.${datePart}.su`;
    }

    const HOME_MENU_ANIMATION_LOCK_MS = 320;
    let homeMenuCloseTimer = null;
    let sidebarAnimating = false;
    let touchStartX = 0;
    let touchCurrentX = 0;
    let isDraggingSidebar = false;
    let sidebarWidth = 0;
    const homeMenuStateKey = '__homeMenuOpen__';
    const homeMenuCloseButton = requireElement('homeMenuCloseButton');

    function finalizeHomeMenuClose() {
      if (!homeMenuPanel) {
        return;
      }
      if (homeMenuOverlay) {
        homeMenuOverlay.hidden = true;
        homeMenuOverlay.classList.remove('is-open');
      }
      document.body.classList.remove('sidebar-open');
      homeMenuButton?.setAttribute('aria-expanded', 'false');
      if (window.history.state?.[homeMenuStateKey]) {
        window.history.back();
      }
      homeMenuPanel.hidden = true;
      homeMenuPanel.classList.remove('is-open', 'is-closing');
      homeMenuPanel.style.transform = '';
      homeMenuPanel.style.transition = '';
      if (homeMenuOverlay) {
        homeMenuOverlay.style.opacity = '';
      }
      isDraggingSidebar = false;
      sidebarAnimating = false;
    }

    function closeSidebar() {
      if (!homeMenuPanel || !homeMenuButton || sidebarAnimating) {
        return;
      }
      if (!homeMenuOverlay || homeMenuOverlay.hidden || homeMenuPanel.classList.contains('is-closing')) {
        finalizeHomeMenuClose();
        return;
      }
      sidebarAnimating = true;
      if (homeMenuCloseTimer) {
        window.clearTimeout(homeMenuCloseTimer);
        homeMenuCloseTimer = null;
      }

      homeMenuPanel.classList.remove('is-open');
      homeMenuPanel.classList.add('is-closing');
      homeMenuPanel.style.transform = '';
      const onTransitionEnd = (event) => {
        if (event.target !== homeMenuPanel) {
          return;
        }
        finalizeHomeMenuClose();
      };
      homeMenuPanel.addEventListener('transitionend', onTransitionEnd, { once: true });
      homeMenuCloseTimer = window.setTimeout(() => {
        homeMenuPanel.removeEventListener('transitionend', onTransitionEnd);
        finalizeHomeMenuClose();
        homeMenuCloseTimer = null;
      }, HOME_MENU_ANIMATION_LOCK_MS);
    }

    function openSidebar() {
      if (!homeMenuPanel || !homeMenuButton || sidebarAnimating) {
        return;
      }
      updateSidebarPermissions();
      if (!homeMenuOverlay?.hidden || homeMenuPanel.classList.contains('is-open')) {
        return;
      }
      if (homeMenuCloseTimer) {
        window.clearTimeout(homeMenuCloseTimer);
        homeMenuCloseTimer = null;
      }
      if (!homeMenuOverlay) {
        return;
      }
      sidebarAnimating = true;
      homeMenuOverlay.hidden = false;
      homeMenuPanel.hidden = false;
      document.body.classList.add('sidebar-open');
      homeMenuPanel.classList.remove('is-closing');
      window.requestAnimationFrame(() => {
        if (homeMenuOverlay.hidden) {
          return;
        }
        homeMenuPanel.classList.add('is-open');
      });
      homeMenuOverlay.classList.add('is-open');
      homeMenuButton.setAttribute('aria-expanded', 'true');
      if (!window.history.state?.[homeMenuStateKey]) {
        window.history.pushState({ ...(window.history.state || {}), [homeMenuStateKey]: true }, '');
      }
      window.setTimeout(() => {
        sidebarAnimating = false;
      }, HOME_MENU_ANIMATION_LOCK_MS);
    }


    function downloadSuFile(fileName, content) {
      const blob = new Blob([content], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }

    async function handleImportFile(fileInput) {
      const [file] = Array.from(fileInput.files || []);
      if (!file) {
        fileInput.remove();
        return;
      }

      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const imported = await StorageService.importData(payload);
        if (!imported) {
          UiService.showToast('Fichier .su invalide.');
          return;
        }
        UiService.showToast('Données importées.');
      } catch (_error) {
        UiService.showToast('Importation impossible.');
      } finally {
        fileInput.value = '';
        fileInput.remove();
      }
    }

    function exportAllData() {
      const payload = StorageService.exportData();
      const serialized = JSON.stringify(payload, null, 2);
      downloadSuFile(formatExportFileName(), serialized);
      UiService.showToast('Exportation des données lancée.');
    }

    function openImportFilePicker() {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.su,.json,application/json';
      fileInput.hidden = true;
      fileInput.tabIndex = -1;
      fileInput.setAttribute('aria-hidden', 'true');
      fileInput.addEventListener(
        'change',
        () => {
          handleImportFile(fileInput);
        },
        { once: true },
      );
      document.body.appendChild(fileInput);

      try {
        if (typeof fileInput.showPicker === 'function') {
          fileInput.showPicker();
          return;
        }
      } catch (_error) {
        // Certains navigateurs refusent showPicker sur certains contextes.
      }

      fileInput.click();
    }

    function ensureSiteActionBottomSheet() {
      let overlay = document.getElementById('siteActionSheetOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'siteActionSheetOverlay';
      overlay.className = 'bottom-sheet-overlay item-action-sheet-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="bottom-sheet item-action-sheet" id="siteActionSheet" role="dialog" aria-modal="true" aria-label="Actions du site">
          <div class="bottom-sheet__handle" aria-hidden="true"></div>
          <p class="item-action-sheet__title" id="siteActionSheetTitle">Actions</p>
          <div class="item-action-sheet__content">
            <button type="button" class="item-action-sheet__row" id="siteActionLockToggleButton">
              <img src="Icon/cle.png" alt="" aria-hidden="true" class="item-action-sheet__icon" />
              <span id="siteActionLockToggleLabel">Verrouiller</span>
            </button>
            <div class="item-action-sheet__divider" id="siteActionDividerAfterLock" aria-hidden="true"></div>
            <button type="button" class="item-action-sheet__row" id="siteActionEditNameButton">
              <img src="Icon/crayon-de-blog.png" alt="" aria-hidden="true" class="item-action-sheet__icon" />
              <span>Modifier le nom</span>
            </button>
            <div class="item-action-sheet__divider" id="siteActionDividerBeforeDelete" aria-hidden="true"></div>
            <button type="button" class="item-action-sheet__row item-action-sheet__row--danger" id="siteActionDeleteButton">
              <img src="Icon/poubelle.png" alt="" aria-hidden="true" class="item-action-sheet__icon" />
              <span>Supprimer</span>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function ensureSiteDeleteConfirmationDialog() {
      let overlay = document.getElementById('siteDeleteConfirmOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'siteDeleteConfirmOverlay';
      overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <article class="maintenance-card item-delete-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="siteDeleteConfirmTitle">
          <h3 id="siteDeleteConfirmTitle">Supprimer ce site ?</h3>
          <div class="modal-actions item-delete-confirm-actions">
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--cancel" id="siteDeleteCancelButton">Annuler</button>
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--danger" id="siteDeleteConfirmButton">Supprimer</button>
          </div>
        </article>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function getSiteCreatorName(site) {
      return String(site?.createdByName || '').trim() || resolveActorLabel(site?.createdBy, userNamesById, 'Utilisateur');
    }

    function getSiteCreatorEmail(site) {
      return String(site?.createdByEmail || '').trim() || userEmailsById?.[String(site?.createdBy || '')] || '';
    }

    function canCurrentUserDeleteSite(site) {
      if (currentPermissions?.isAdmin) {
        return true;
      }
      const currentUserId = String(currentPermissions?.userId || firebaseAuth.currentUser?.uid || '').trim();
      const creatorId = String(site?.createdBy || site?.ownerId || '').trim();
      return Boolean(currentUserId && creatorId && currentUserId === creatorId);
    }

    function showSiteDeleteForbiddenOverlay(site) {
      let overlay = document.getElementById('siteDeleteForbiddenOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'siteDeleteForbiddenOverlay';
        overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
          <article class="maintenance-card item-delete-confirm-card site-delete-forbidden-card" role="alertdialog" aria-modal="true" aria-labelledby="siteDeleteForbiddenTitle" aria-describedby="siteDeleteForbiddenDescription">
            <div class="site-delete-forbidden-icon" aria-hidden="true">
              <span class="material-icons-round">warning_amber</span>
            </div>
            <h3 id="siteDeleteForbiddenTitle">Suppression impossible</h3>
            <p id="siteDeleteForbiddenDescription">Seul le créateur de ce site est autorisé à supprimer ce site.</p>
            <div class="site-delete-forbidden-creator" id="siteDeleteForbiddenCreator">
              <span class="site-delete-forbidden-creator__icon material-icons-round" aria-hidden="true">person</span>
              <span class="site-delete-forbidden-creator__content">
                <span class="site-delete-forbidden-creator__label">Créateur du site</span>
                <strong id="siteDeleteForbiddenCreatorName"></strong>
                <span id="siteDeleteForbiddenCreatorEmail"></span>
              </span>
            </div>
            <div class="modal-actions item-delete-confirm-actions site-delete-forbidden-actions">
              <button type="button" class="btn item-delete-confirm-button site-delete-forbidden-close-button" id="siteDeleteForbiddenCloseButton">OK</button>
            </div>
          </article>
        `;
        document.body.appendChild(overlay);
      }

      const creatorName = overlay.querySelector('#siteDeleteForbiddenCreatorName');
      const creatorEmail = overlay.querySelector('#siteDeleteForbiddenCreatorEmail');
      const closeButton = overlay.querySelector('#siteDeleteForbiddenCloseButton');
      if (creatorName) {
        creatorName.textContent = getSiteCreatorName(site);
      }
      if (creatorEmail) {
        creatorEmail.textContent = getSiteCreatorEmail(site);
      }

      const close = () => {
        overlay.classList.remove('is-open');
        window.setTimeout(() => {
          overlay.hidden = true;
          overlay.onclick = null;
          if (closeButton) {
            closeButton.onclick = null;
          }
          document.removeEventListener('keydown', handleKeyDown);
        }, 170);
      };
      const handleKeyDown = (event) => {
        if (event.key === 'Escape') {
          close();
        }
      };

      if (closeButton) {
        closeButton.onclick = close;
      }
      overlay.onclick = (event) => {
        if (event.target === overlay) {
          close();
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      overlay.hidden = false;
      window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
      });
    }

    function ensureInactiveSiteOverlay() {
      let overlay = document.getElementById('inactiveSiteOverlay');
      if (overlay) {
        return overlay;
      }
      overlay = document.createElement('div');
      overlay.id = 'inactiveSiteOverlay';
      overlay.className = 'maintenance-overlay item-delete-confirm-overlay inactive-site-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <article class="maintenance-card item-delete-confirm-card inactive-site-card" role="alertdialog" aria-modal="true" aria-labelledby="inactiveSiteTitle">
          <h3 id="inactiveSiteTitle">⚠️ Site inactif</h3>
          <p id="inactiveSiteText"></p>
          <div class="modal-actions item-delete-confirm-actions inactive-site-actions">
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--cancel inactive-site-restore" id="inactiveSiteRestoreButton">🟢 Restaurer</button>
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--danger inactive-site-delete" id="inactiveSiteDeleteButton">🔴 Supprimer</button>
          </div>
        </article>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function openInactiveSiteOverlay(site) {
      const overlay = ensureInactiveSiteOverlay();
      const text = overlay.querySelector('#inactiveSiteText');
      const restoreButton = overlay.querySelector('#inactiveSiteRestoreButton');
      const deleteButton = overlay.querySelector('#inactiveSiteDeleteButton');
      if (!text || !restoreButton || !deleteButton) {
        return Promise.resolve('skipped');
      }
      restoreButton.disabled = false;
      deleteButton.disabled = false;
      const siteName = String(site?.nom || '').trim() || 'ce site';
      text.innerHTML = `Nous avons remarqué que votre site <strong>${escapeHtml(siteName)}</strong> est resté inactif pendant ${StorageService.getSiteInactivityThresholdDays?.() || 30} jours en conservant <strong>0 OUT</strong>.<br><br>Souhaitez-vous le restaurer ou le supprimer définitivement ?`;

      return new Promise((resolve) => {
        let isClosing = false;
        const cleanup = () => {
          overlay.hidden = true;
          overlay.classList.remove('is-open');
          restoreButton.onclick = null;
          deleteButton.onclick = null;
          document.removeEventListener('keydown', handleKeyDown);
        };
        const close = (value) => {
          if (isClosing) {
            return;
          }
          isClosing = true;
          overlay.classList.remove('is-open');
          window.setTimeout(() => {
            cleanup();
            resolve(value);
          }, 170);
        };
        const handleKeyDown = (event) => {
          if (event.key === 'Escape') {
            close('deferred');
          }
        };
        restoreButton.onclick = async () => {
          restoreButton.disabled = true;
          deleteButton.disabled = true;
          const result = await StorageService.restoreInactiveSite(site.id);
          UiService.showToast(result?.ok ? 'Site restauré.' : 'Restauration impossible.');
          close(result?.ok ? 'restored' : 'deferred');
        };
        deleteButton.onclick = async () => {
          overlay.classList.remove('is-open');
          overlay.hidden = true;
          const shouldDelete = await askSiteDeleteConfirmation(siteName);
          if (!shouldDelete) {
            overlay.hidden = false;
            window.requestAnimationFrame(() => overlay.classList.add('is-open'));
            return;
          }
          restoreButton.disabled = true;
          deleteButton.disabled = true;
          const removedSnapshot = await StorageService.removeSite(site.id);
          UiService.showToast(removedSnapshot ? 'Site supprimé définitivement.' : 'Suppression impossible.');
          close(removedSnapshot ? 'deleted' : 'deferred');
        };
        document.addEventListener('keydown', handleKeyDown);
        overlay.hidden = false;
        window.requestAnimationFrame(() => overlay.classList.add('is-open'));
      });
    }

    let inactiveSitePromptRunning = false;
    async function promptInactiveSitesForCreator() {
      if (!authState?.isAuthenticated || inactiveSitePromptRunning) {
        return;
      }
      inactiveSitePromptRunning = true;
      try {
        const sites = await StorageService.refreshSiteInactivityStates?.();
        const pendingSites = Array.isArray(sites) ? sites : StorageService.listInactiveSitesForCurrentCreator?.() || [];
        for (const site of pendingSites) {
          const result = await openInactiveSiteOverlay(site);
          if (result === 'deferred') {
            break;
          }
        }
      } catch (_error) {
        UiService.showToast('Vérification des sites inactifs indisponible.');
      } finally {
        inactiveSitePromptRunning = false;
      }
    }

    function askSiteDeleteConfirmation(siteName) {
      const overlay = ensureSiteDeleteConfirmationDialog();
      const cancelButton = overlay.querySelector('#siteDeleteCancelButton');
      const confirmButton = overlay.querySelector('#siteDeleteConfirmButton');
      if (!cancelButton || !confirmButton) {
        return Promise.resolve(false);
      }

      const title = overlay.querySelector('#siteDeleteConfirmTitle');
      const normalizedSiteName = String(siteName || '').trim() || 'inconnu';
      if (title) {
        title.textContent = `Supprimer ce site ${normalizedSiteName} ?`;
      }
      return new Promise((resolve) => {
        const closeAnimationDurationMs = 170;
        let closeAnimationTimer = null;
        let isClosing = false;
        const cleanup = () => {
          if (closeAnimationTimer) {
            window.clearTimeout(closeAnimationTimer);
            closeAnimationTimer = null;
          }
          overlay.hidden = true;
          overlay.classList.remove('is-open');
          overlay.onclick = null;
          cancelButton.onclick = null;
          confirmButton.onclick = null;
          document.removeEventListener('keydown', handleKeyDown);
          siteActionState.closeConfirmation = null;
        };
        const close = (value) => {
          if (isClosing) {
            return;
          }
          isClosing = true;
          overlay.classList.remove('is-open');
          closeAnimationTimer = window.setTimeout(() => {
            cleanup();
            resolve(value);
          }, closeAnimationDurationMs);
        };
        const handleKeyDown = (event) => {
          if (event.key === 'Escape') {
            close(false);
          }
        };

        siteActionState.closeConfirmation = () => close(false);
        cancelButton.onclick = () => close(false);
        confirmButton.onclick = () => close(true);
        overlay.onclick = (event) => {
          if (event.target === overlay) {
            close(false);
          }
        };
        document.addEventListener('keydown', handleKeyDown);
        overlay.hidden = false;
        window.requestAnimationFrame(() => {
          overlay.classList.add('is-open');
        });
      });
    }

    function closeActiveSiteTransientLayer() {
      if (typeof siteActionState.closeConfirmation === 'function') {
        siteActionState.closeConfirmation();
        return true;
      }
      if (typeof siteActionState.closeSheet === 'function') {
        siteActionState.closeSheet({ fromPopState: true });
        return true;
      }
      return false;
    }

    function getLatestSiteState(siteId) {
      if (!siteId) {
        return null;
      }
      return StorageService.getSite(siteId) || currentSites.find((site) => site.id === siteId) || null;
    }

    function openSiteLockActionDialog(siteId) {
      if (!isAuthenticated) {
        return;
      }
      const targetSite = getLatestSiteState(siteId);
      if (isSiteLocked(targetSite)) {
        if (
          !siteLockManageDialog ||
          !siteLockCurrentPasswordInput ||
          !siteLockNewPasswordInput ||
          !siteLockCurrentPasswordError ||
          !siteLockNewPasswordError
        ) {
          return;
        }
        siteIdPendingLockManage = siteId;
        siteLockCurrentPasswordInput.value = '';
        siteLockNewPasswordInput.value = '';
        clearSiteLockManageErrors();
        clearSiteLockManageLoadingStates();
        setPasswordVisibility(siteLockCurrentPasswordInput, siteLockCurrentPasswordToggle, false);
        setPasswordVisibility(siteLockNewPasswordInput, siteLockNewPasswordToggle, false);
        setSiteLockManageBlockedState(false);
        clearSiteLockManageAttemptsInfo();
        siteLockManageDialog.showModal();
        refreshSiteLockManageProtectionState(siteId).then((protection) => {
          if (!protection?.isBlocked) {
            siteLockCurrentPasswordInput.focus();
          }
        });
        return;
      }

      if (
        !siteLockDialog ||
        !siteLockPasswordInput ||
        !siteLockConfirmPasswordInput ||
        !siteLockPasswordError ||
        !siteLockConfirmPasswordError
      ) {
        return;
      }
      siteIdPendingLock = siteId;
      siteLockPasswordInput.value = '';
      siteLockConfirmPasswordInput.value = '';
      clearSiteLockFieldErrorState(siteLockPasswordInput, siteLockPasswordError);
      clearSiteLockFieldErrorState(siteLockConfirmPasswordInput, siteLockConfirmPasswordError);
      updateSiteLockStrengthIndicator();
      siteLockDialog.showModal();
      siteLockPasswordInput.focus();
    }

    window.addEventListener('popstate', () => {
      if (siteActionState.ignoreNextPopstate) {
        siteActionState.ignoreNextPopstate = false;
        return;
      }
      closeActiveSiteTransientLayer();
    });

    function openSiteActionSheet(siteId) {
      const overlay = ensureSiteActionBottomSheet();
      const sheet = overlay.querySelector('#siteActionSheet');
      const title = overlay.querySelector('#siteActionSheetTitle');
      const lockToggleButton = overlay.querySelector('#siteActionLockToggleButton');
      const lockToggleLabel = overlay.querySelector('#siteActionLockToggleLabel');
      const editNameButton = overlay.querySelector('#siteActionEditNameButton');
      const deleteButton = overlay.querySelector('#siteActionDeleteButton');
      const dividerAfterLock = overlay.querySelector('#siteActionDividerAfterLock');
      const dividerBeforeDelete = overlay.querySelector('#siteActionDividerBeforeDelete');
      if (!sheet || !title || !lockToggleButton || !lockToggleLabel || !editNameButton || !deleteButton || !dividerAfterLock || !dividerBeforeDelete) {
        return;
      }
      const closeTransitionDurationMs = 280;
      const refreshSiteActionSheetContent = () => {
        const latestSite = getLatestSiteState(siteId);
        if (!latestSite) {
          closeSheet();
          return null;
        }

        title.textContent = String(latestSite.nom || '').trim() || 'Actions';
        const siteIsLocked = isSiteLocked(latestSite);
        const canDeleteSite = isAuthenticated && currentPermissions.canDelete && !siteIsLocked;
        lockToggleLabel.textContent = siteIsLocked ? 'Déverrouiller' : 'Verrouiller';
        const canEditSiteName = !siteIsLocked;
        editNameButton.hidden = !canEditSiteName;
        editNameButton.style.display = canEditSiteName ? 'inline-flex' : 'none';
        editNameButton.disabled = !canEditSiteName;
        deleteButton.hidden = !canDeleteSite;
        deleteButton.style.display = canDeleteSite ? 'inline-flex' : 'none';
        deleteButton.disabled = !canDeleteSite;

        const showDividerAfterLock = canEditSiteName || canDeleteSite;
        const showDividerBeforeDelete = canEditSiteName && canDeleteSite;

        dividerAfterLock.hidden = !showDividerAfterLock;
        dividerAfterLock.style.display = showDividerAfterLock ? '' : 'none';

        dividerBeforeDelete.hidden = !showDividerBeforeDelete;
        dividerBeforeDelete.style.display = showDividerBeforeDelete ? '' : 'none';
        return latestSite;
      };

      const clearCloseListeners = () => {
        if (overlay.__closeTimerId) {
          window.clearTimeout(overlay.__closeTimerId);
          overlay.__closeTimerId = null;
        }
        if (overlay.__closeTransitionHandler) {
          overlay.removeEventListener('transitionend', overlay.__closeTransitionHandler);
          overlay.__closeTransitionHandler = null;
        }
      };

      const closeSheet = ({ fromPopState = false } = {}) =>
        new Promise((resolve) => {
          if (overlay.hidden) {
            resolve();
            return;
          }
          let isResolved = false;
          const finish = () => {
            if (isResolved) {
              return;
            }
            isResolved = true;
            clearCloseListeners();
            overlay.hidden = true;
            overlay.classList.remove('is-open');
            siteActionState.activeSiteId = null;
            siteActionState.closeSheet = null;
            siteActionState.refreshSheetContent = null;
            if (siteActionState.hasHistoryEntry && !fromPopState) {
              siteActionState.hasHistoryEntry = false;
              siteActionState.ignoreNextPopstate = true;
              window.history.back();
            } else if (fromPopState) {
              siteActionState.hasHistoryEntry = false;
            }
            resolve();
          };

          overlay.classList.remove('is-open');
          overlay.__closeTransitionHandler = (event) => {
            if (event.target !== overlay && event.target !== sheet) {
              return;
            }
            finish();
          };
          overlay.addEventListener('transitionend', overlay.__closeTransitionHandler);
          overlay.__closeTimerId = window.setTimeout(finish, closeTransitionDurationMs);
        });

      siteActionState.activeSiteId = siteId;
      siteActionState.closeSheet = closeSheet;
      siteActionState.refreshSheetContent = refreshSiteActionSheetContent;
      const activeSite = refreshSiteActionSheetContent();
      if (!activeSite) {
        return;
      }
      lockToggleButton.onclick = async () => {
        await closeSheet();
        openSiteLockActionDialog(siteId);
      };
      editNameButton.onclick = async () => {
        const targetSite = getLatestSiteState(siteId);
        if (isSiteLocked(targetSite)) {
          UiService.showToast('Impossible de modifier le nom tant que le site est verrouillé.');
          refreshSiteActionSheetContent();
          return;
        }
        await closeSheet();
        if (!targetSite || !siteEditNameDialog || !siteEditNameInput) {
          return;
        }
        siteActionState.activeSiteId = siteId;
        siteEditNameInput.value = String(targetSite.nom || '').trim();
        clearTransientError(siteEditNameError);
        clearSiteEditNameErrorState();
        setSiteEditNameLoadingState(false);
        updateSiteEditNameCounter();
        siteEditNameDialog.showModal();
        siteEditNameInput.focus();
      };
      deleteButton.onclick = async () => {
        const latestSiteState = getLatestSiteState(siteId);
        if (!latestSiteState || isSiteLocked(latestSiteState)) {
          UiService.showToast('Suppression impossible tant que le site est verrouillé.');
          refreshSiteActionSheetContent();
          return;
        }
        if (!canCurrentUserDeleteSite(latestSiteState)) {
          await closeSheet();
          showSiteDeleteForbiddenOverlay(latestSiteState);
          return;
        }
        deleteButton.disabled = true;
        try {
          await closeSheet();
          const shouldDelete = await askSiteDeleteConfirmation(latestSiteState.nom || 'inconnu');
          if (!shouldDelete) {
            return;
          }
          const removedSnapshot = await StorageService.removeSite(siteId);
          if (!removedSnapshot) {
            UiService.showToast('Suppression impossible.');
            return;
          }
          UiService.showUndoSnackbar('Site supprimé.', async () => {
            const restored = await StorageService.restoreSite(removedSnapshot);
            UiService.showToast(restored ? 'Suppression annulée.' : 'Restauration impossible.');
          });
        } finally {
          deleteButton.disabled = false;
        }
      };

      overlay.onclick = (event) => {
        if (event.target === overlay) {
          closeSheet();
        }
      };

      let touchStartY = null;
      sheet.ontouchstart = (event) => {
        touchStartY = event.touches[0]?.clientY ?? null;
      };
      sheet.ontouchend = (event) => {
        if (touchStartY === null) {
          return;
        }
        const touchEndY = event.changedTouches[0]?.clientY ?? touchStartY;
        if (touchEndY - touchStartY > 60) {
          closeSheet();
        }
        touchStartY = null;
      };

      overlay.hidden = false;
      clearCloseListeners();
      if (!siteActionState.hasHistoryEntry) {
        window.history.pushState({ siteActionSheet: true }, '');
        siteActionState.hasHistoryEntry = true;
      }
      window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
      });
    }

    function renderSites() {
      const query = searchInput.value.trim().toUpperCase();
      const sites = currentSites
        .filter((site) => String(site.nom || '').toUpperCase().includes(query))
        .sort(compareSitesByName);
      const siteCountLabel = document.getElementById('siteCountLabel');
      if (siteCountLabel) {
        siteCountLabel.textContent = sites.length === 1 ? 'Nombre total de site :' : 'Nombre total des sites :';
      }
      siteCount.textContent = String(sites.length);

      if (!sites.length) {
        UiService.renderEmptyState(
          siteList,
          query ? 'Aucun site ne correspond à votre recherche.' : 'Aucun site enregistré pour le moment.',
        );
        return;
      }

      siteList.innerHTML = sites
        .map((site) => {
          const outCount = itemCountsBySite[site.id] || 0;
          const createdDateTime = buildDateAndTimeLabel(site?.dateCreation);
          const createdBy = resolveActorLabel(site?.createdBy, userNamesById, site?.createdByName);
          const canChangeCreator = canCurrentUserChangeSiteCreator();
          const creatorMarkup = canChangeCreator
            ? `<span class="site-creator-name site-creator-edit" data-site-creator="${escapeHtml(site.id)}" role="button" tabindex="0" title="Modifier le créateur" aria-label="Modifier le créateur du site ${escapeHtml(site.nom)}">${escapeHtml(createdBy)}</span>`
            : `<span class="site-creator-name">${escapeHtml(createdBy)}</span>`;
          const lockIconSrc = isSiteLocked(site) ? 'Icon/Cadenas_close.png' : 'Icon/Cadenas_Open.png';
          const siteIsLocked = isSiteLocked(site);
          const lockLabel = siteIsLocked ? 'Verrouillé' : 'Déverrouillé';
          const canShowSiteActions = isAuthenticated;
          const isPendingCreatorDecision = Boolean(StorageService.isSitePendingInactivityDecision?.(site));
          const pendingDecisionBadge = isPendingCreatorDecision
            ? '<span class="list-card__pending-decision-badge">En attente de votre décision</span>'
            : '';
          return `
            <article class="list-card ${isPendingCreatorDecision ? 'list-card--pending-decision' : ''}">
              ${canShowSiteActions ? `<button class="list-card__menu-button" type="button" data-site-menu="${site.id}" aria-label="Plus d'actions" title="Plus d'actions"><img src="Icon/Trois point.png" alt="" aria-hidden="true" class="list-card__menu-icon" /></button>` : ''}
              <button class="list-card__button" type="button" data-site-open="${site.id}">
                <h3 class="list-card__title">${escapeHtml(site.nom)}</h3>
                ${pendingDecisionBadge}
                <div class="list-card__meta">
                  <span class="list-card__meta-item list-card__meta-item--outs">
                    <img src="Icon/OUT.png" alt="" aria-hidden="true" class="icon" />
                    <span class="outs-count"><span class="outs-number">${outCount}</span><span class="outs-label">OUT${outCount > 1 ? 'S' : ''}</span></span>
                  </span>
                  <span class="list-card__meta-item">
                    <img src="Icon/Date et Heure.png" alt="" aria-hidden="true" class="icon" />
                    <span>Créé le ${escapeHtml(createdDateTime)}</span>
                  </span>
                  <span class="list-card__meta-item">
                    <img src="Icon/Utilisateur.png" alt="" aria-hidden="true" class="icon" />
                    ${creatorMarkup}
                  </span>
                </div>
                <span class="list-card__divider" aria-hidden="true"></span>
                <span class="list-card__status ${siteIsLocked ? 'list-card__status--locked' : 'list-card__status--unlocked'}" data-site-lock-status="${site.id}" aria-label="Voir l'auteur du statut ${escapeHtml(lockLabel)}">
                  <img src="${lockIconSrc}" alt="" aria-hidden="true" class="list-card__status-icon" />
                  <span class="list-card__status-text">
                    <span class="list-card__status-main">${escapeHtml(lockLabel)}</span>
                  </span>
                </span>
              </button>
            </article>
          `;
        })
        .join('');


      siteList.querySelectorAll('[data-site-creator]').forEach((creatorElement) => {
        const openCreatorSelect = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!canCurrentUserChangeSiteCreator()) {
            return;
          }
          const siteId = creatorElement.dataset.siteCreator;
          const site = getLatestSiteState(siteId);
          const users = getActiveCreatorUsers();
          if (!site || !users.length) {
            UiService.showToast('Aucun utilisateur actif disponible.');
            return;
          }

          const select = document.createElement('select');
          select.className = 'site-creator-select';
          select.setAttribute('aria-label', 'Choisir le créateur du site');
          users
            .slice()
            .sort((userA, userB) => String(userA.username || userA.email || '').localeCompare(String(userB.username || userB.email || ''), 'fr', { sensitivity: 'base' }))
            .forEach((user) => {
              const option = document.createElement('option');
              option.value = user.id;
              option.textContent = user.username || user.displayName || user.name || user.email || 'Utilisateur';
              option.selected = user.id === String(site.createdBy || site.ownerId || '');
              select.appendChild(option);
            });

          creatorElement.replaceWith(select);
          select.focus();
          select.addEventListener('click', (selectEvent) => selectEvent.stopPropagation());
          select.addEventListener('blur', () => renderSites(), { once: true });
          select.addEventListener('change', async (changeEvent) => {
            changeEvent.preventDefault();
            changeEvent.stopPropagation();
            const selectedUser = users.find((user) => user.id === select.value);
            if (!selectedUser) {
              renderSites();
              return;
            }
            select.disabled = true;
            const result = await StorageService.updateSiteCreator(siteId, selectedUser);
            if (!result?.ok) {
              UiService.showToast('Modification du créateur impossible.');
              renderSites();
              return;
            }
            UiService.showToast('Créateur du site mis à jour.');
          });
        };
        creatorElement.addEventListener('click', openCreatorSelect);
        creatorElement.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            openCreatorSelect(event);
          }
        });
      });

      siteList.querySelectorAll('[data-site-open]').forEach((button) => {
        const siteId = button.dataset.siteOpen;

        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
        });

        button.addEventListener('click', (event) => {
          const statusTarget = event.target.closest('[data-site-lock-status]');
          if (statusTarget) {
            event.preventDefault();
            event.stopPropagation();
            const targetSite = getLatestSiteState(statusTarget.dataset.siteLockStatus);
            const targetIsLocked = isSiteLocked(targetSite);
            const actorLabel = targetIsLocked
              ? resolveSiteLockActorLabel(targetSite?.lockedBy, targetSite?.lockedByName, userNamesByEmail)
              : resolveSiteLockActorLabel(targetSite?.unlockedBy, targetSite?.unlockedByName, userNamesByEmail);
            const icon = targetIsLocked ? '🔒' : '🔓';
            const statusTitle = targetIsLocked ? 'Site verrouillé' : 'Site déverrouillé';
            const statusDescription = targetIsLocked
              ? 'Ce site est actuellement verrouillé.'
              : 'Ce site est actuellement déverrouillé.';
            const actorHeading = targetIsLocked ? 'Verrouillé par' : 'Dernier déverrouillage effectué par';
            const actorName = actorLabel || 'Utilisateur inconnu';
            if (siteLockStatusMessage) {
              siteLockStatusMessage.innerHTML = `
                <article class="site-lock-status-card">
                  <h3 class="site-lock-status-card__title"><span aria-hidden="true">${icon}</span>${escapeHtml(statusTitle)}</h3>
                  <p class="site-lock-status-card__description">${escapeHtml(statusDescription)}</p>
                  <div class="site-lock-status-card__actor">
                    <span class="site-lock-status-card__actor-label">${escapeHtml(actorHeading)}</span>
                    <strong class="site-lock-status-card__actor-name">${escapeHtml(actorName)}</strong>
                  </div>
                </article>
              `;
              siteLockStatusMessage.classList.toggle('site-lock-status-message--locked', targetIsLocked);
              siteLockStatusMessage.classList.toggle('site-lock-status-message--unlocked', !targetIsLocked);
            }
            siteLockStatusDialog?.showModal();
            return;
          }
          const targetSite = getLatestSiteState(siteId);
          if (!isSiteLocked(targetSite)) {
            UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
            return;
          }
          if (!siteUnlockDialog || !siteUnlockPasswordInput || !siteUnlockError) {
            return;
          }
          siteIdPendingUnlock = siteId;
          siteUnlockPasswordInput.value = '';
          clearSiteUnlockFieldErrorState();
          setPasswordVisibility(siteUnlockPasswordInput, siteUnlockPasswordToggle, false);
          setSiteUnlockLoadingState(false);
          setSiteUnlockBlockedState(false);
          siteUnlockDialog.showModal();
          refreshSiteUnlockProtectionState(siteId).then((protection) => {
            if (!protection?.isBlocked) {
              siteUnlockPasswordInput.focus();
            }
          });
        });
      });

      siteList.querySelectorAll('[data-site-menu]').forEach((button) => {
        button.addEventListener('click', () => {
          openSiteActionSheet(button.dataset.siteMenu);
        });
      });
    }

    if (homeMenuButton && homeMenuPanel && homeMenuOverlay) {
      homeMenuButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSidebar();
      });


      homeMenuPanel.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      homeMenuPanel.addEventListener('touchstart', (event) => {
        if (!homeMenuPanel.classList.contains('is-open') || sidebarAnimating) {
          return;
        }
        touchStartX = event.touches[0].clientX;
        touchCurrentX = touchStartX;
        sidebarWidth = homeMenuPanel.offsetWidth || 0;
        isDraggingSidebar = true;
        homeMenuPanel.style.transition = 'none';
      }, { passive: true });

      homeMenuPanel.addEventListener('touchmove', (event) => {
        if (!isDraggingSidebar || !sidebarWidth) {
          return;
        }
        touchCurrentX = event.touches[0].clientX;
        const deltaX = touchCurrentX - touchStartX;
        if (deltaX < 0) {
          const translateX = Math.max(deltaX, -sidebarWidth);
          homeMenuPanel.style.transform = `translateX(${translateX}px)`;
          const progress = Math.min(Math.abs(deltaX) / sidebarWidth, 1);
          homeMenuOverlay.style.opacity = String(1 - progress * 0.45);
        }
      }, { passive: true });

      homeMenuPanel.addEventListener('touchend', () => {
        if (!isDraggingSidebar) {
          return;
        }
        isDraggingSidebar = false;
        const deltaX = touchCurrentX - touchStartX;
        homeMenuPanel.style.transition = '';
        homeMenuOverlay.style.opacity = '';
        if (Math.abs(deltaX) > sidebarWidth * 0.35 && deltaX < 0) {
          closeSidebar();
          return;
        }
        homeMenuPanel.style.transform = '';
      });

      homeMenuPanel.addEventListener('touchcancel', () => {
        isDraggingSidebar = false;
        homeMenuPanel.style.transition = '';
        homeMenuPanel.style.transform = '';
        homeMenuOverlay.style.opacity = '';
      });

      homeMenuOverlay.addEventListener('click', closeSidebar);

      homeMenuCloseButton?.addEventListener('click', closeSidebar);
      window.addEventListener('popstate', () => {
        if (!homeMenuOverlay?.hidden) {
          closeSidebar();
        }
      });
    }

    function setActiveSidebarItem(targetItem) {
      sidebarItems.forEach((item) => item.classList.remove('active'));
      if (targetItem) {
        targetItem.classList.add('active');
      }
    }

    if (sidebarItems.length) {
      const currentPage = window.location.pathname;
      let activeItemFromPage = null;

      sidebarItems.forEach((item) => {
        const link = String(item.getAttribute('data-link') || '').trim();
        if (link && currentPage.includes(link)) {
          activeItemFromPage = item;
        }
        item.addEventListener('click', () => {
          setActiveSidebarItem(item);
        });
      });

      setActiveSidebarItem(activeItemFromPage);
    }

    function openHistory() {
      window.location.href = 'historiques.html';
    }

    function openImportModal() {
      openImportFilePicker();
    }

    function openUserManagement() {
      window.location.href = 'users.html';
    }

    let sidebarActionRunning = false;
    function runSidebarAction(action) {
      if (sidebarActionRunning) {
        return;
      }

      sidebarActionRunning = true;
      closeSidebar();

      window.setTimeout(() => {
        action();
        sidebarActionRunning = false;
      }, 200);
    }

    if (exportDataButton) {
      exportDataButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        runSidebarAction(exportAllData);
      });
    }

    if (importDataButton) {
      importDataButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        runSidebarAction(openImportModal);
      });
    }
    if (usersSidebarBtn) {
      usersSidebarBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.location.assign('users.html');
      });
    }


    if (allMaterialsSidebarBtn) {
      allMaterialsSidebarBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.location.assign('materiels.html');
      });
    }



    if (historySidebarBtn) {
      historySidebarBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.location.assign('historiques.html');
      });
    }

    const openCreateSite = requireElement('openCreateSite');

    function mettreAJourHeaderUtilisateur(authUser) {
      const authUserData = normalizeAuthUserData(authUser);
      renderHomeAccessControls({
        authUser: authUserData,
        onAvatarClick: () => openAvatarBottomSheet(authUserData),
      });
    }

    function getCurrentUserRole() {
      if (currentPermissions?.isAdmin) {
        return 'admin';
      }
      if (currentPermissions?.isStandard) {
        return 'standard';
      }
      return 'limite';
    }

    function setSidebarItemVisible(selector, visible) {
      const el = document.querySelector(selector);
      if (!el) {
        return;
      }
      el.hidden = !visible;
      el.style.display = visible ? 'flex' : 'none';
    }

    function updateSidebarPermissions() {
      const user = firebaseAuth.currentUser;
      const role = getCurrentUserRole();
      const isConnected = Boolean(user);
      const normalizedRole = String(role || '').toLowerCase();
      const isAdmin = normalizedRole === 'admin';
      const isStandard = normalizedRole === 'standard';
      const isLimited = normalizedRole === 'limité' || normalizedRole === 'limite' || normalizedRole === 'limited';

      setSidebarItemVisible('#sidebarHistoryBtn', isAdmin);
      setSidebarItemVisible('#sidebarAllMaterialsBtn', isConnected);
      

      if (!isConnected || isLimited) {
        setSidebarItemVisible('#sidebarImportBtn', false);
        setSidebarItemVisible('#sidebarExportBtn', false);
        setSidebarItemVisible('#sidebarUsersBtn', false);
        return;
      }

      if (isStandard) {
        setSidebarItemVisible('#sidebarImportBtn', true);
        setSidebarItemVisible('#sidebarExportBtn', true);
        setSidebarItemVisible('#sidebarUsersBtn', false);
        return;
      }

      if (isAdmin) {
        setSidebarItemVisible('#sidebarImportBtn', true);
        setSidebarItemVisible('#sidebarExportBtn', true);
        setSidebarItemVisible('#sidebarUsersBtn', true);
        return;
      }

      setSidebarItemVisible('#sidebarImportBtn', false);
      setSidebarItemVisible('#sidebarExportBtn', false);
      setSidebarItemVisible('#sidebarUsersBtn', false);
    }

    function mettreAJourPermissionsUI(nextPermissions) {
      currentPermissions = { ...currentPermissions, ...(nextPermissions || {}) };

      if (openCreateSite) {
        openCreateSite.hidden = !isAuthenticated;
      }

      updateSidebarPermissions();

      closeSidebar();
      renderSites();
    }

    mettreAJourHeaderUtilisateur(authState?.authUser || null);
    mettreAJourPermissionsUI(currentPermissions);
    if (isAuthenticated) {
      showGoogleWelcomeOverlay(authState?.authUser || firebaseAuth.currentUser);
    }
    onAuthStateChanged(firebaseAuth, (user) => {
      isAuthenticated = Boolean(user);
      renderUserAvatar(user || null);
      mettreAJourHeaderUtilisateur(user || null);
      mettreAJourPermissionsUI(currentPermissions);
      renderSites();
    });

    openCreateSite?.addEventListener('click', () => {
      if (!currentPermissions.canCreate) {
        UiService.showToast('Action non autorisée.');
        return;
      }
      siteForm.reset();
      clearTransientError(siteFormError);
      clearSiteNameErrorState();
      setSiteCreateLoadingState(false);
      clearSiteNameAvailabilityMessage();
      setSiteCreateSubmitEnabled(false);
      updateSiteNameCounter();
      siteDialog.showModal();
      siteNameInput.focus();
    });

    searchInput.addEventListener('input', renderSites);

    siteNameInput.addEventListener('beforeinput', (event) => {
      const maxLength = getSiteNameMaxLength();
      if (!maxLength || event.inputType.startsWith('delete')) {
        return;
      }

      const selectionStart = siteNameInput.selectionStart ?? siteNameInput.value.length;
      const selectionEnd = siteNameInput.selectionEnd ?? siteNameInput.value.length;
      const selectedLength = Math.max(0, selectionEnd - selectionStart);
      const nextAllowedLength = maxLength - (siteNameInput.value.length - selectedLength);
      if (nextAllowedLength <= 0) {
        event.preventDefault();
      }
    });
    siteEditNameInput?.addEventListener('beforeinput', (event) => {
      const maxLength = getSiteEditNameMaxLength();
      if (!maxLength || event.inputType.startsWith('delete')) {
        return;
      }
      const selectionStart = siteEditNameInput.selectionStart ?? siteEditNameInput.value.length;
      const selectionEnd = siteEditNameInput.selectionEnd ?? siteEditNameInput.value.length;
      const selectedLength = Math.max(0, selectionEnd - selectionStart);
      const nextAllowedLength = maxLength - (siteEditNameInput.value.length - selectedLength);
      if (nextAllowedLength <= 0) {
        event.preventDefault();
      }
    });

    siteNameInput.addEventListener('input', () => {
      clearTransientError(siteFormError);
      siteFormError.style.color = '';
      clearSiteNameErrorState();
      updateSiteNameCounter();
      if (siteNameAvailabilityDebounceTimer) {
        window.clearTimeout(siteNameAvailabilityDebounceTimer);
      }
      siteNameAvailabilityDebounceTimer = window.setTimeout(() => {
        validateSiteNameDuringInput();
      }, 200);
    });

    siteCreateSubmitButton?.addEventListener('click', () => {
      if (isSiteCreationPending) {
        return;
      }
      siteForm.requestSubmit();
    });
    siteEditNameInput?.addEventListener('input', () => {
      clearTransientError(siteEditNameError);
      clearSiteEditNameErrorState();
      updateSiteEditNameCounter();
    });

    siteDialog.addEventListener('close', () => {
      if (siteNameAvailabilityDebounceTimer) {
        window.clearTimeout(siteNameAvailabilityDebounceTimer);
        siteNameAvailabilityDebounceTimer = null;
      }
      clearSiteNameAvailabilityMessage();
      setSiteCreateSubmitEnabled(false);
      setSiteCreateLoadingState(false);
      updateSiteNameCounter();
    });
    siteEditNameDialog?.addEventListener('close', () => {
      clearTransientError(siteEditNameError);
      clearSiteEditNameErrorState();
      setSiteEditNameLoadingState(false);
      updateSiteEditNameCounter();
    });

    siteForm.addEventListener('submit', async (event) => {
      console.log('site validation triggered');
      event.preventDefault();
      if (isSiteCreationPending) {
        return;
      }
      const name = siteNameInput.value.trim();
      if (!name) {
        showSiteNameError('Veuillez renseigner le nom du site.');
        siteNameInput.focus();
        return;
      }

      if (name.length < 4) {
        showSiteNameError('Le nom doit contenir au moins 4 caractères.');
        return;
      }

      if (isSiteNameAlreadyUsed(name.toLowerCase())) {
        showSiteNameError('Ce nom de site existe déjà.');
        return;
      }

      if (!currentPermissions.canCreate) {
        showSiteNameError('Action non autorisée.');
        return;
      }

      try {
        setSiteCreateLoadingState(true);
        const result = await StorageService.createSite(name);
        if (!result?.ok) {
          showSiteNameError(
            result?.reason === 'duplicate_site'
              ? 'Ce nom de site existe déjà.'
              : 'Création impossible. Vérifiez le nom du site.',
          );
          setSiteCreateLoadingState(false);
          return;
        }

        setSiteCreateLoadingState(false);
        siteDialog.close();
        UiService.showToast('Site créé avec succés.');
      } catch (error) {
        console.error('Erreur lors de la création du site :', error);
        showSiteNameError("Impossible d'enregistrer le site. Vérifiez Firestore et réessayez.");
        setSiteCreateLoadingState(false);
      }
    });
    siteEditNameForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isSiteNameEditPending) {
        return;
      }
      const siteId = siteActionState.activeSiteId;
      const targetSite = getLatestSiteState(siteId);
      if (!siteId || !targetSite) {
        siteEditNameDialog?.close();
        return;
      }
      if (isSiteLocked(targetSite)) {
        siteEditNameDialog?.close();
        UiService.showToast('Impossible de modifier le nom tant que le site est verrouillé.');
        return;
      }
      const currentName = String(targetSite.nom || '').trim();
      const nextName = String(siteEditNameInput?.value || '').trim();
      if (!nextName) {
        showSiteEditNameError('Veuillez entrer un nom de site.');
        return;
      }
      if (nextName.length < 4) {
        showSiteEditNameError('Le nom doit contenir au moins 4 caractères.');
        return;
      }
      if (nextName.length > 25) {
        showSiteEditNameError('Le nom doit contenir au maximum 25 caractères.');
        return;
      }
      if (nextName === currentName) {
        siteEditNameDialog?.close();
        return;
      }
      try {
        setSiteEditNameLoadingState(true);
        const result = await StorageService.updateSiteName(siteId, nextName);
        if (!result?.ok) {
          showSiteEditNameError(result?.reason === 'duplicate_site' ? 'Ce nom de site existe déjà.' : 'Modification impossible.');
          setSiteEditNameLoadingState(false);
          return;
        }
        setSiteEditNameLoadingState(false);
        siteEditNameDialog?.close();
        UiService.showToast('Nom du site mis à jour.');
      } catch (_error) {
        showSiteEditNameError("Impossible d'enregistrer le nom du site.");
        setSiteEditNameLoadingState(false);
      }
    });

    siteLockForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!siteIdPendingLock) {
        return;
      }
      clearSiteLockFieldErrorState(siteLockPasswordInput, siteLockPasswordError);
      clearSiteLockFieldErrorState(siteLockConfirmPasswordInput, siteLockConfirmPasswordError);
      const passwordValue = siteLockPasswordInput?.value || '';
      const confirmValue = siteLockConfirmPasswordInput?.value || '';

      const isPasswordMissing = !passwordValue.trim();
      const isConfirmMissing = !confirmValue.trim();
      if (isPasswordMissing || isConfirmMissing) {
        if (isPasswordMissing) {
          showSiteLockFieldError(siteLockPasswordInput, siteLockPasswordError, 'Veuillez remplir ce champ');
        }
        if (isConfirmMissing) {
          showSiteLockFieldError(siteLockConfirmPasswordInput, siteLockConfirmPasswordError, 'Veuillez remplir ce champ');
        }
        return;
      }

      if (passwordValue !== confirmValue) {
        showSiteLockFieldError(
          siteLockConfirmPasswordInput,
          siteLockConfirmPasswordError,
          'Les mots de passe ne correspondent pas.',
        );
        return;
      }

      try {
        const passwordHash = await hashPassword(passwordValue);
        const result = await StorageService.setSiteLock(siteIdPendingLock, { passwordHash, historyAction: 'a protégé le site par un mot de passe' });
        if (!result?.ok) {
          showSiteLockFieldError(siteLockConfirmPasswordInput, siteLockConfirmPasswordError, 'Impossible de verrouiller ce site.');
          return;
        }
        siteLockDialog?.close();
        siteIdPendingLock = null;
        UiService.showToast('Site protégé par un mot de passe.');
      } catch (_error) {
        showSiteLockFieldError(siteLockConfirmPasswordInput, siteLockConfirmPasswordError, 'Erreur pendant le verrouillage.');
      }
    });

    siteLockPasswordInput?.addEventListener('input', () => {
      clearSiteLockFieldErrorState(siteLockPasswordInput, siteLockPasswordError);
      updateSiteLockStrengthIndicator();
    });

    siteLockConfirmPasswordInput?.addEventListener('input', () => {
      clearSiteLockFieldErrorState(siteLockConfirmPasswordInput, siteLockConfirmPasswordError);
    });


    siteLockStatusCloseButton?.addEventListener('click', () => {
      siteLockStatusDialog?.close();
    });

    siteLockStatusDialog?.addEventListener('click', (event) => {
      if (event.target === siteLockStatusDialog) {
        siteLockStatusDialog.close();
      }
    });

    siteUnlockPasswordInput?.addEventListener('input', () => {
      clearSiteUnlockFieldErrorState();
    });

    siteUnlockPasswordToggle?.addEventListener('click', () => {
      const nextIsVisible = siteUnlockPasswordInput?.type === 'password';
      setPasswordVisibility(siteUnlockPasswordInput, siteUnlockPasswordToggle, nextIsVisible);
    });

    siteLockCurrentPasswordInput?.addEventListener('input', () => {
      clearSiteLockManageFieldErrorState(siteLockCurrentPasswordInput, siteLockCurrentPasswordError);
    });

    siteLockNewPasswordInput?.addEventListener('input', () => {
      clearSiteLockManageFieldErrorState(siteLockNewPasswordInput, siteLockNewPasswordError);
    });

    siteLockCurrentPasswordToggle?.addEventListener('click', () => {
      const nextIsVisible = siteLockCurrentPasswordInput?.type === 'password';
      setPasswordVisibility(siteLockCurrentPasswordInput, siteLockCurrentPasswordToggle, nextIsVisible);
    });

    siteLockNewPasswordToggle?.addEventListener('click', () => {
      const nextIsVisible = siteLockNewPasswordInput?.type === 'password';
      setPasswordVisibility(siteLockNewPasswordInput, siteLockNewPasswordToggle, nextIsVisible);
    });

    siteUnlockForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!siteIdPendingUnlock || isSiteUnlockPending) {
        return;
      }
      clearSiteUnlockFieldErrorState();
      const protection = await refreshSiteUnlockProtectionState(siteIdPendingUnlock);
      if (protection?.isBlocked) {
        return;
      }
      const passwordValue = siteUnlockPasswordInput?.value || '';
      if (!passwordValue.trim()) {
        showSiteUnlockFieldError('Veuillez entrer le mot de passe.');
        return;
      }

      const targetSite = getLatestSiteState(siteIdPendingUnlock);
      if (!isSiteLocked(targetSite)) {
        setSiteUnlockLoadingState(true);
        siteUnlockDialog?.close();
        UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteIdPendingUnlock)}`);
        siteIdPendingUnlock = null;
        setSiteUnlockLoadingState(false);
        return;
      }

      try {
        setSiteUnlockLoadingState(true);
        const passwordHash = await hashPassword(passwordValue);
        if (passwordHash !== targetSite.passwordHash) {
          const failure = await StorageService.registerSiteUnlockFailure(siteIdPendingUnlock);
          await StorageService.recordSiteUnlockFailureHistory(siteIdPendingUnlock, failure?.attemptsRemaining);
          clearSiteUnlockAttemptsInfo();
          if (failure?.isBlocked) {
            setSiteUnlockBlockedState(true);
            clearSiteUnlockFieldErrorState();
            scheduleSiteUnlockUnblock(siteIdPendingUnlock, failure.blockedUntil);
          } else {
            showSiteUnlockFieldError(`Mot de passe incorrect. ${formatAttemptsRemainingMessage(failure?.attemptsRemaining)}`);
          }
          setSiteUnlockLoadingState(false);
          return;
        }
        await StorageService.resetSiteUnlockProtection(siteIdPendingUnlock);
        await StorageService.recordSiteUnlockHistory(siteIdPendingUnlock);
        const openSiteId = siteIdPendingUnlock;
        siteUnlockDialog?.close();
        siteIdPendingUnlock = null;
        UiService.navigate(`page2.html?siteId=${encodeURIComponent(openSiteId)}`);
      } catch (_error) {
        showSiteUnlockFieldError('Erreur pendant la vérification.');
        setSiteUnlockLoadingState(false);
      }
    });

    siteLockManageForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!siteIdPendingLockManage) {
        return;
      }

      const submittedAction = event.submitter?.dataset?.lockManageAction === 'unlock' ? 'unlock' : 'update';
      if (
        (submittedAction === 'unlock' && isSiteLockManageUnlockPending) ||
        (submittedAction === 'update' && isSiteLockManageUpdatePending)
      ) {
        return;
      }

      clearSiteLockManageErrors();
      const protection = await refreshSiteLockManageProtectionState(siteIdPendingLockManage);
      if (protection?.isBlocked) {
        return;
      }

      const currentPasswordValue = siteLockCurrentPasswordInput?.value || '';
      const newPasswordValue = siteLockNewPasswordInput?.value || '';
      const targetSite = getLatestSiteState(siteIdPendingLockManage);
      if (!isSiteLocked(targetSite)) {
        clearSiteLockManageLoadingStates();
        siteLockManageDialog?.close();
        siteIdPendingLockManage = null;
        return;
      }

      if (!currentPasswordValue.trim()) {
        showSiteLockManageFieldError(
          siteLockCurrentPasswordInput,
          siteLockCurrentPasswordError,
          'Veuillez remplir ce champ',
        );
        return;
      }

      if (submittedAction === 'update' && !newPasswordValue.trim()) {
        showSiteLockManageFieldError(siteLockNewPasswordInput, siteLockNewPasswordError, 'Veuillez remplir ce champ');
        return;
      }

      try {
        setSiteLockManageActionLoadingState(submittedAction, true);
        const currentPasswordHash = await hashPassword(currentPasswordValue);
        if (currentPasswordHash !== targetSite.passwordHash) {
          const failure = await StorageService.registerSiteUnlockFailure(siteIdPendingLockManage);
          clearSiteLockManageAttemptsInfo();
          if (failure?.isBlocked) {
            setSiteLockManageBlockedState(true);
            clearSiteLockManageFieldErrorState(siteLockCurrentPasswordInput, siteLockCurrentPasswordError);
            scheduleSiteLockManageUnblock(siteIdPendingLockManage, failure.blockedUntil);
          } else {
            showSiteLockManageFieldError(
              siteLockCurrentPasswordInput,
              siteLockCurrentPasswordError,
              `Mot de passe actuel incorrect. ${formatAttemptsRemainingMessage(failure?.attemptsRemaining)}`,
            );
          }
          setSiteLockManageActionLoadingState(submittedAction, false);
          return;
        }

        await StorageService.resetSiteUnlockProtection(siteIdPendingLockManage);

        if (submittedAction === 'unlock') {
          const result = await StorageService.clearSiteLock(siteIdPendingLockManage);
          if (!result?.ok) {
            showSiteLockManageFieldError(
              siteLockCurrentPasswordInput,
              siteLockCurrentPasswordError,
              'Impossible de retirer le verrouillage.',
            );
            setSiteLockManageActionLoadingState('unlock', false);
            return;
          }
          siteLockManageDialog?.close();
          siteIdPendingLockManage = null;
          UiService.showToast('Le verrouillage a été retiré avec succès.');
          return;
        }

        const nextPasswordHash = await hashPassword(newPasswordValue);
        const result = await StorageService.setSiteLock(siteIdPendingLockManage, { passwordHash: nextPasswordHash, historyAction: 'a changé le mot de passe du site' });
        if (!result?.ok) {
          showSiteLockManageFieldError(
            siteLockNewPasswordInput,
            siteLockNewPasswordError,
            'Impossible de mettre à jour le mot de passe.',
          );
          setSiteLockManageActionLoadingState('update', false);
          return;
        }
        siteLockManageDialog?.close();
        siteIdPendingLockManage = null;
        UiService.showToast('Le mot de passe a été mis à jour avec succès.');
      } catch (_error) {
        if (submittedAction === 'unlock') {
          showSiteLockManageFieldError(
            siteLockCurrentPasswordInput,
            siteLockCurrentPasswordError,
            'Erreur pendant la gestion du mot de passe.',
          );
          setSiteLockManageActionLoadingState('unlock', false);
          return;
        }
        showSiteLockManageFieldError(
          siteLockNewPasswordInput,
          siteLockNewPasswordError,
          'Erreur pendant la gestion du mot de passe.',
        );
        setSiteLockManageActionLoadingState('update', false);
      }
    });

    siteLockDialog?.addEventListener('close', () => {
      siteIdPendingLock = null;
      clearSiteLockFieldErrorState(siteLockPasswordInput, siteLockPasswordError);
      clearSiteLockFieldErrorState(siteLockConfirmPasswordInput, siteLockConfirmPasswordError);
      updateSiteLockStrengthIndicator();
    });

    siteUnlockDialog?.addEventListener('close', () => {
      siteIdPendingUnlock = null;
      clearSiteUnlockBlockTimer();
      clearSiteUnlockFieldErrorState();
      clearSiteUnlockAttemptsInfo();
      setSiteUnlockBlockedState(false);
      setPasswordVisibility(siteUnlockPasswordInput, siteUnlockPasswordToggle, false);
      setSiteUnlockLoadingState(false);
    });

    siteLockManageDialog?.addEventListener('close', () => {
      siteIdPendingLockManage = null;
      clearSiteLockManageBlockTimer();
      clearSiteLockManageErrors();
      clearSiteLockManageAttemptsInfo();
      clearSiteLockManageLoadingStates();
      setSiteLockManageBlockedState(false);
      setPasswordVisibility(siteLockCurrentPasswordInput, siteLockCurrentPasswordToggle, false);
      setPasswordVisibility(siteLockNewPasswordInput, siteLockNewPasswordToggle, false);
    });

    StorageService.subscribeSites(
      (sites) => {
        currentSites = sites;
        renderSites();
        if (siteActionState.activeSiteId && typeof siteActionState.refreshSheetContent === 'function') {
          siteActionState.refreshSheetContent();
        }
        promptInactiveSitesForCreator();
      },
      () => {
        UiService.showToast('Synchronisation indisponible.');
      },
    );

    StorageService.subscribeItemCounts(
      (counts) => {
        itemCountsBySite = counts;
        renderSites();
      },
      () => {
        UiService.showToast('Comptage des sous-éléments indisponible.');
      },
    );

    loadUserNames();
  }

  function initSiteDetailPage(permissions) {
    initAuthRequiredNoticeCard();

    const params = UiService.getQueryParams();
    const siteId = params.get('siteId');
    if (!siteId) {
      UiService.navigate('index.html');
      return;
    }

    const siteTitle = requireElement('siteTitle');
    const itemList = requireElement('itemList');
    const itemCount = requireElement('itemCount');
    const itemDialog = requireElement('itemDialog');
    const itemForm = requireElement('itemForm');
    const itemNumberInput = requireElement('itemNumberInput');
    const itemStoreSelect = requireElement('itemStoreSelect');
    const itemStoreError = requireElement('itemStoreError');
    const itemStoreOtherGroup = requireElement('itemStoreOtherGroup');
    const itemStoreOtherInput = requireElement('itemStoreOtherInput');
    const itemNumberCounter = requireElement('itemNumberCounter');
    const itemFormError = requireElement('itemFormError');
    const itemCreateSubmitButton = requireElement('itemCreateSubmitButton');
    const openExportItems = requireElement('headerExportBtn');
    const siteExportDialog = requireElement('siteExportDialog');
    const siteExportForm = requireElement('siteExportForm');
    const siteExportFileNameInput = requireElement('siteExportFileNameInput');
    const siteExportLineFilterSelect = requireElement('siteExportLineFilterSelect');
    const siteExportFileNameError = requireElement('siteExportFileNameError');
    const siteExportSubmitButton = requireElement('siteExportSubmitButton');
    const siteExportCancelButton = requireElement('siteExportCancelButton');
    const purchaseModal = requireElement('purchaseModal');
    const purchaseForm = requireElement('purchaseForm');
    const purchaseDesignation = requireElement('purchaseDesignation');
    const purchaseDesignationCounter = requireElement('purchaseDesignationCounter');
    const purchaseQty = requireElement('purchaseQty');
    const purchaseUnit = requireElement('purchaseUnit');
    const purchaseStore = requireElement('purchaseStore');
    const purchaseStoreSuggestions = requireElement('purchaseStoreSuggestions');
    const purchaseRemark = requireElement('purchaseRemark');
    const purchasePhotoInput = requireElement('purchasePhotoInput');
    const purchasePhotoPreviewWrap = requireElement('purchasePhotoPreviewWrap');
    const purchasePhotoPreview = requireElement('purchasePhotoPreview');
    const purchaseFormError = requireElement('purchaseFormError');
    const purchaseDesignationError = requireElement('purchaseDesignationError');
    const purchaseQtyError = requireElement('purchaseQtyError');
    const purchaseUnitError = requireElement('purchaseUnitError');
    const purchaseRemarkError = requireElement('purchaseRemarkError');
    const cancelPurchaseBtn = requireElement('cancelPurchaseBtn');
    const savePurchaseBtn = requireElement('savePurchaseBtn');
    const editPurchaseModal = document.getElementById('editPurchaseModal');
    const editPurchaseForm = document.getElementById('editPurchaseForm');
    const editPurchaseNameInput = document.getElementById('editPurchaseNameInput');
    const editPurchaseNameCounter = document.getElementById('editPurchaseNameCounter');
    const editPurchaseRemarkInput = document.getElementById('editPurchaseRemarkInput');
    const editPurchaseRemarkError = document.getElementById('editPurchaseRemarkError');
    const editPurchaseFormError = document.getElementById('editPurchaseFormError');
    const cancelEditPurchaseBtn = document.getElementById('cancelEditPurchaseBtn');
    const saveEditPurchaseBtn = document.getElementById('saveEditPurchaseBtn');
    const editOutNameModal = document.getElementById('editOutNameModal');
    const editOutNameForm = document.getElementById('editOutNameForm');
    const editOutNameInput = document.getElementById('editOutNameInput');
    const editOutNameCounter = document.getElementById('editOutNameCounter');
    const editOutNameFormError = document.getElementById('editOutNameFormError');
    const cancelEditOutNameBtn = document.getElementById('cancelEditOutNameBtn');
    const saveEditOutNameBtn = document.getElementById('saveEditOutNameBtn');
    const itemSearchInput = requireElement('itemSearchInput');
    const itemDateFilter = requireElement('itemDateFilter');
    const itemDialogTitle = itemDialog?.querySelector('.modal-header h2');
    const itemNumberLabel = itemDialog?.querySelector('.input-group--item-create > span');
    const itemNumberLabelText = itemDialog?.querySelector('.item-number-label-text');

    let currentSite = StorageService.getSite(siteId);
    const siteDetailHistoryLogger = createSearchAndFilterHistoryLogger(siteId, () => currentSite?.nom || siteTitle?.textContent || '');
    let currentItems = [];
    let currentPurchases = [];
    let detailCountsByItem = {};
    let detailDesignationsByItem = {};
    let detailRowsByItem = {};
    let userNamesById = {};
    const itemActionState = {
      activeItemId: null,
      closeSheet: null,
      closeConfirmation: null,
      hasHistoryEntry: false,
      ignoreNextPopstate: false,
    };
    const dateFilterStorageKey = `site-detail:item-date-filter:${siteId}`;
    const searchStorageKey = `site-detail:item-search:${siteId}`;
    const searchReadIdsStorageKey = 'page2_search_read_ids';
    const cursorFilterReadOutsStorageKey = 'page2_cursor_filter_read_outs';
    const cursorFilterActiveStorageKey = 'page2_cursor_filter_active';
    const outPageScrollStorageKey = 'outPageScrollY';
    const filterChipButtons = Array.from(document.querySelectorAll('[data-filter-chip]'));
    const itemStatusFilterButton = document.getElementById('itemStatusFilterButton');
    const itemStatusFilterMenu = document.getElementById('itemStatusFilterMenu');
    const itemStatusFilterMenuWrap = itemStatusFilterButton?.closest('.page2-filter-menu-wrap');
    const itemStatusFilterOptions = Array.from(document.querySelectorAll('[data-item-status-filter]'));
    const itemProgressStatsCard = document.getElementById('itemProgressStatsCard');
    const itemProgressTotal = document.getElementById('itemProgressTotal');
    const itemProgressDoneMeta = document.getElementById('itemProgressDoneMeta');
    const itemProgressTodoMeta = document.getElementById('itemProgressTodoMeta');
    const itemProgressFixMeta = document.getElementById('itemProgressFixMeta');
    const itemProgressKoMeta = document.getElementById('itemProgressKoMeta');
    const itemProgressDoneFill = document.getElementById('itemProgressDoneFill');
    const itemProgressTodoFill = document.getElementById('itemProgressTodoFill');
    const itemProgressFixFill = document.getElementById('itemProgressFixFill');
    const itemProgressKoFill = document.getElementById('itemProgressKoFill');
    let selectedDateFilter = window.localStorage.getItem(dateFilterStorageKey) || 'all';
    const statusFilterKeyByLabel = {
      'Tous': 'all',
      'À faire': 'todo',
      'À corriger': 'fix',
      'Complété': 'done',
      'K.O': 'ko',
    };
    const statusFilterLabelByKey = {
      all: 'Tous',
      todo: 'À faire',
      fix: 'À corriger',
      done: 'Complété',
      ko: 'K.O',
    };
    const storedCursorFilterLabel = window.localStorage.getItem(cursorFilterActiveStorageKey) || 'Tous';
    let activeStatusFilter = statusFilterKeyByLabel[storedCursorFilterLabel] || 'all';
    const readCursorFilterOuts = new Set();
    itemSearchInput.value = window.localStorage.getItem(searchStorageKey) || '';
    try {
      const initialPage2SearchValue = String(itemSearchInput.value || '');
      if (initialPage2SearchValue) {
        window.localStorage.setItem('page2_search_value', initialPage2SearchValue);
      } else {
        window.localStorage.removeItem('page2_search_value');
      }
    } catch (_error) {
      // Ignore localStorage restrictions.
    }
    let hasPendingOutScrollRestore = true;
    let selectedPurchasePhotoFile = null;
    let selectedPurchasePhotoPreviewUrl = '';

    function persistOutPageScrollPosition() {
      if (activeSiteTab !== 'outs') {
        return;
      }
      try {
        window.localStorage.setItem(outPageScrollStorageKey, String(Math.max(0, Math.round(window.scrollY || 0))));
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function restoreOutPageScrollPosition() {
      if (!hasPendingOutScrollRestore || activeSiteTab !== 'outs') {
        return;
      }
      hasPendingOutScrollRestore = false;
      let savedScrollY = 0;
      try {
        savedScrollY = Number.parseInt(window.localStorage.getItem(outPageScrollStorageKey) || '0', 10);
      } catch (_error) {
        savedScrollY = 0;
      }
      if (!Number.isFinite(savedScrollY) || savedScrollY <= 0) {
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          window.scrollTo(0, savedScrollY);
        }, 40);
      });
    }

    siteTitle.textContent = currentSite ? currentSite.nom : 'Chargement...';

    function resetPurchaseForm() {
      purchaseForm?.reset();
      if (purchaseUnit) {
        purchaseUnit.value = 'Pcs';
      }
      if (purchaseFormError) {
        purchaseFormError.textContent = '';
      }
      clearPurchaseFieldError(purchaseDesignation, purchaseDesignationError);
      clearPurchaseFieldError(purchaseQty, purchaseQtyError);
      clearPurchaseFieldError(purchaseUnit, purchaseUnitError);
      clearPurchaseFieldError(purchaseRemark, purchaseRemarkError);
      hidePurchaseStoreSuggestions();
      selectedPurchasePhotoFile = null;
      if (selectedPurchasePhotoPreviewUrl) {
        URL.revokeObjectURL(selectedPurchasePhotoPreviewUrl);
        selectedPurchasePhotoPreviewUrl = '';
      }
      if (purchasePhotoPreview) {
        purchasePhotoPreview.src = '';
      }
      purchasePhotoPreviewWrap?.classList.add('hidden');
    }

    function getCloudinaryUploadConfig() {
      const cloudName = 'dskw13nem';
      return {
        cloudName,
        uploadPreset: 'Suivi_matériel',
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      };
    }

    async function uploadPurchaseImageToCloudinary(file) {
      if (!file) {
        return null;
      }
      const { uploadPreset, uploadUrl } = getCloudinaryUploadConfig();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', uploadPreset);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error('Erreur Cloudinary :', data);
        throw new Error(data.error?.message || 'Upload Cloudinary échoué');
      }

      const imageUrl = String(data?.secure_url || '').trim();
      const publicId = String(data?.public_id || '').trim();
      if (!imageUrl || !publicId) {
        console.error('Erreur Cloudinary :', data);
        throw new Error('Upload Cloudinary échoué');
      }

      return { imageUrl, publicId };
    }

    function showPurchaseFieldError(field, errorElement, message) {
      if (errorElement) {
        errorElement.textContent = message;
      }
      field?.classList.remove('input-error', 'is-error', 'is-shaking', 'shake');
      void field?.offsetWidth;
      field?.classList.add('input-error', 'is-error', 'is-shaking', 'shake');
      field?.focus();
    }

    function clearPurchaseFieldError(field, errorElement) {
      if (errorElement) {
        errorElement.textContent = '';
      }
      field?.classList.remove('input-error', 'is-error', 'is-shaking', 'shake');
    }

    function setPurchaseSubmitLoadingState(isLoading) {
      if (!savePurchaseBtn) return;
      savePurchaseBtn.disabled = isLoading;
      savePurchaseBtn.classList.toggle('is-loading', isLoading);
    }


    function normalizePurchaseStoreSuggestionKey(store) {
      return String(store || '').trim().toLowerCase();
    }

    function buildPurchaseStoreSuggestionList(extraSuggestions = []) {
      const suggestionsByKey = new Map();
      [...defaultPurchaseStoreSuggestions, ...extraSuggestions].forEach((store) => {
        const cleanStore = String(store || '').trim();
        const key = normalizePurchaseStoreSuggestionKey(cleanStore);
        if (!key || suggestionsByKey.has(key)) {
          return;
        }
        suggestionsByKey.set(key, cleanStore);
      });
      return Array.from(suggestionsByKey.values()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    }

    function loadStoredPurchaseStoreSuggestions() {
      try {
        const storedValue = window.localStorage.getItem(purchaseStoreSuggestionsStorageKey);
        const parsedValue = JSON.parse(storedValue || '[]');
        return Array.isArray(parsedValue) ? parsedValue : [];
      } catch (_error) {
        return [];
      }
    }

    function savePurchaseStoreSuggestions() {
      try {
        window.localStorage.setItem(purchaseStoreSuggestionsStorageKey, JSON.stringify(purchaseStoreSuggestionSource));
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function addPurchaseStoreSuggestion(store) {
      const cleanStore = String(store || '').trim();
      const key = normalizePurchaseStoreSuggestionKey(cleanStore);
      if (!key || purchaseStoreSuggestionSource.some((suggestion) => normalizePurchaseStoreSuggestionKey(suggestion) === key)) {
        return;
      }
      purchaseStoreSuggestionSource = buildPurchaseStoreSuggestionList([cleanStore, ...purchaseStoreSuggestionSource]);
      savePurchaseStoreSuggestions();
    }

    function getPurchaseStoreMatches(query) {
      const normalizedQuery = String(query || '').trim().toLowerCase();
      if (!normalizedQuery) {
        return purchaseStoreSuggestionSource.slice(0, 8);
      }

      return purchaseStoreSuggestionSource
        .map((store) => {
          const storeLower = store.toLowerCase();
          const matchIndex = storeLower.indexOf(normalizedQuery);
          return { store, matchIndex, startsWith: storeLower.startsWith(normalizedQuery) };
        })
        .filter((item) => item.matchIndex !== -1)
        .sort((a, b) => {
          if (a.startsWith !== b.startsWith) {
            return a.startsWith ? -1 : 1;
          }
          if (a.matchIndex !== b.matchIndex) {
            return a.matchIndex - b.matchIndex;
          }
          return a.store.localeCompare(b.store, 'fr', { sensitivity: 'base' });
        })
        .slice(0, 8)
        .map((item) => item.store);
    }

    function buildPurchaseStoreHighlightedText(text, query) {
      const safeText = String(text || '');
      const normalizedQuery = String(query || '').trim();
      if (!normalizedQuery) {
        return escapeHtml(safeText);
      }

      const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
      return escapeHtml(safeText).replace(matcher, '<mark>$1</mark>');
    }

    function setActivePurchaseStoreSuggestion(index) {
      activePurchaseStoreSuggestionIndex = index;
      if (!purchaseStoreSuggestions) {
        return;
      }

      purchaseStoreSuggestions.querySelectorAll('.typeahead__option').forEach((option, optionIndex) => {
        const isActive = optionIndex === index;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          option.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function hidePurchaseStoreSuggestions() {
      visiblePurchaseStoreSuggestions = [];
      activePurchaseStoreSuggestionIndex = -1;
      if (!purchaseStoreSuggestions) {
        return;
      }
      purchaseStoreSuggestions.hidden = true;
      purchaseStoreSuggestions.style.display = 'none';
      purchaseStoreSuggestions.innerHTML = '';
    }

    function applyPurchaseStoreSuggestion(store) {
      if (!store || !purchaseStore) {
        return;
      }
      purchaseStore.value = store;
      hidePurchaseStoreSuggestions();
    }

    function renderPurchaseStoreSuggestions(query) {
      if (!purchaseStoreSuggestions) {
        return;
      }

      const normalizedQuery = String(query || '').trim();
      if (!normalizedQuery) {
        hidePurchaseStoreSuggestions();
        return;
      }

      visiblePurchaseStoreSuggestions = getPurchaseStoreMatches(query);
      activePurchaseStoreSuggestionIndex = -1;

      if (!visiblePurchaseStoreSuggestions.length) {
        hidePurchaseStoreSuggestions();
        return;
      }

      purchaseStoreSuggestions.hidden = false;
      purchaseStoreSuggestions.style.display = 'block';
      purchaseStoreSuggestions.innerHTML = visiblePurchaseStoreSuggestions
        .map(
          (store, index) => `
            <button
              type="button"
              class="typeahead__option"
              role="option"
              data-purchase-store-typeahead-index="${index}"
              aria-selected="false"
            >
              <span class="typeahead__code">${buildPurchaseStoreHighlightedText(store, query)}</span>
            </button>
          `,
        )
        .join('');
    }

    function openCreatePurchaseModal() {
      resetPurchaseForm();
      updatePurchaseDesignationCounter();
      purchaseModal?.showModal();
      purchaseDesignation?.focus();
    }

    function updatePurchaseDesignationCounter() {
      if (!purchaseDesignation || !purchaseDesignationCounter) return;
      if (purchaseDesignation.value.length > 25) {
        purchaseDesignation.value = purchaseDesignation.value.slice(0, 25);
      }
      purchaseDesignationCounter.textContent = `${purchaseDesignation.value.length} / 25`;
    }

    function updateEditPurchaseCounter() {
      if (!editPurchaseNameInput || !editPurchaseNameCounter) return;
      if (editPurchaseNameInput.value.length > 25) {
        editPurchaseNameInput.value = editPurchaseNameInput.value.slice(0, 25);
      }
      editPurchaseNameCounter.textContent = `${editPurchaseNameInput.value.length} / 25`;
    }

    function showEditPurchaseFieldError(message) {
      if (!editPurchaseFormError) return;
      editPurchaseFormError.textContent = message;
      editPurchaseFormError.style.color = 'var(--danger)';
      editPurchaseNameInput?.classList.remove('is-shaking');
      void editPurchaseNameInput?.offsetWidth;
      editPurchaseNameInput?.classList.add('input-error', 'is-error', 'is-shaking', 'shake');
    }

    function clearEditPurchaseFieldError() {
      if (!editPurchaseFormError) return;
      editPurchaseFormError.textContent = '';
      editPurchaseFormError.style.color = '';
      editPurchaseNameInput?.classList.remove('input-error', 'is-error', 'is-shaking', 'shake');
    }

    function setEditPurchaseSubmitLoadingState(isLoading) {
      if (!saveEditPurchaseBtn) return;
      saveEditPurchaseBtn.disabled = isLoading;
      saveEditPurchaseBtn.classList.toggle('is-loading', isLoading);
    }

    function updateEditOutNameCounter() {
      if (!editOutNameInput || !editOutNameCounter) return;
      const maxLength = Number(editOutNameInput.maxLength);
      if (Number.isFinite(maxLength) && maxLength >= 0 && editOutNameInput.value.length > maxLength) {
        editOutNameInput.value = editOutNameInput.value.slice(0, maxLength);
      }
      const counterMax = Number.isFinite(maxLength) && maxLength >= 0 ? maxLength : editOutNameInput.value.length;
      editOutNameCounter.textContent = `${editOutNameInput.value.length} / ${counterMax}`;
    }

    function showEditOutNameFieldError(message) {
      if (!editOutNameFormError) return;
      editOutNameFormError.textContent = message;
      editOutNameFormError.style.color = 'var(--danger)';
      editOutNameInput?.classList.remove('is-shaking');
      void editOutNameInput?.offsetWidth;
      editOutNameInput?.classList.add('input-error', 'is-error', 'is-shaking', 'shake');
    }

    function clearEditOutNameFieldError() {
      if (!editOutNameFormError) return;
      editOutNameFormError.textContent = '';
      editOutNameFormError.style.color = '';
      editOutNameInput?.classList.remove('input-error', 'is-error', 'is-shaking', 'shake');
    }

    function setEditOutNameSubmitLoadingState(isLoading) {
      if (!saveEditOutNameBtn) return;
      saveEditOutNameBtn.disabled = isLoading;
      saveEditOutNameBtn.classList.toggle('is-loading', isLoading);
    }

    function openEditOutNameModal(item) {
      if (!item || !editOutNameModal || !editOutNameInput) return;
      selectedOutItemId = item.id;
      editOutNameInput.value = normalizeItemNumberInput(item.numero || '');
      clearEditOutNameFieldError();
      updateEditOutNameCounter();
      editOutNameModal.showModal();
      window.setTimeout(() => editOutNameInput.focus(), 150);
    }

    function openEditPurchaseModal(purchase) {
      if (!purchase || !editPurchaseModal || !editPurchaseNameInput || !canCurrentUserEditPurchase(purchase)) return;
      selectedPurchaseId = purchase.id;
      selectedPurchaseData = purchase;
      editPurchaseNameInput.value = String(purchase.designation || '');
      if (editPurchaseRemarkInput) {
        editPurchaseRemarkInput.value = String(purchase.remarque || purchase.remark || '').trim();
      }
      clearEditPurchaseFieldError();
      updateEditPurchaseCounter();
      editPurchaseModal.showModal();
      window.setTimeout(() => editPurchaseNameInput.focus(), 150);
    }

    async function savePurchase() {
      clearPurchaseFieldError(purchaseDesignation, purchaseDesignationError);
      clearPurchaseFieldError(purchaseQty, purchaseQtyError);
      clearPurchaseFieldError(purchaseUnit, purchaseUnitError);
      clearPurchaseFieldError(purchaseRemark, purchaseRemarkError);
      if (purchaseFormError) {
        purchaseFormError.textContent = '';
      }
      const designation = String(purchaseDesignation?.value || '').trim();
      const qty = Number(purchaseQty?.value);
      const unit = String(purchaseUnit?.value || '').trim();
      const store = String(purchaseStore?.value || '').trim();
      const remark = String(purchaseRemark?.value || '').trim();
      if (!designation) {
        showPurchaseFieldError(purchaseDesignation, purchaseDesignationError, 'Désignation obligatoire');
        return;
      }
      if (!qty || qty <= 0) {
        showPurchaseFieldError(purchaseQty, purchaseQtyError, 'Quantité invalide');
        return;
      }
      if (!['Pcs', 'm', 'Paquet'].includes(unit)) {
        showPurchaseFieldError(purchaseUnit, purchaseUnitError, 'Unité invalide');
        return;
      }
      const currentUserId = String(permissions?.userId || firebaseAuth.currentUser?.uid || '').trim();
      const currentUserName = String(
        permissions?.username
        || firebaseAuth.currentUser?.displayName
        || firebaseAuth.currentUser?.email
        || '',
      ).trim();
      const currentUserEmail = String(firebaseAuth.currentUser?.email || '').trim();
      setPurchaseSubmitLoadingState(true);
      try {
        const uploadedImage = selectedPurchasePhotoFile ? await uploadPurchaseImageToCloudinary(selectedPurchasePhotoFile) : null;
        const purchasePayload = {
          designation,
          qty,
          unit,
          store,
          magasin: store,
          remarque: remark,
          remark,
          createdAt: serverTimestamp(),
          createdBy: currentUserId || null,
          createdByName: currentUserName || 'Utilisateur',
          createdByEmail: currentUserEmail || '',
          siteId,
          siteName: currentSite?.nom || '',
        };
        if (uploadedImage?.imageUrl) {
          purchasePayload.imageUrl = uploadedImage.imageUrl;
          purchasePayload.imagePublicId = uploadedImage.publicId;
        }
        await addDoc(
          collection(firebaseDb, 'sites', siteId, 'achatsMateriels'),
          purchasePayload,
        );
        addPurchaseStoreSuggestion(store);
        purchaseModal?.close();
        resetPurchaseForm();
        await loadPurchasesForCurrentSite();
      } catch (_error) {
        if (purchaseFormError) {
          purchaseFormError.textContent = 'Erreur lors de l’enregistrement de l’achat';
        }
      } finally {
        setPurchaseSubmitLoadingState(false);
      }
    }


    async function loadUserNames() {
      try {
        const users = await StorageService.listUsers();
        userNamesById = users.reduce((accumulator, user) => {
          if (user?.id) {
            accumulator[user.id] = user.username || 'Utilisateur';
          }
          return accumulator;
        }, {});
      } catch (_error) {
        userNamesById = {};
      }
      renderItems(options);
    }

    function formatSiteExportUnit(unit) {
      const normalizedUnit = String(unit || '').trim().toLowerCase();
      if (normalizedUnit === 'pcs') {
        return 'pcs';
      }
      return normalizedUnit || 'm';
    }

    function buildSiteExportRows() {
      const itemsWithLines = currentItems.filter((item) => Number(detailCountsByItem[item.id] || 0) > 0);
      return itemsWithLines.flatMap((item) =>
        (detailRowsByItem[item.id] || []).map((detail) => ({
          out: item.numero,
          champ: detail.champ,
          code: detail.code,
          designation: detail.designation,
          qteSortie: detail.qteSortie,
          unite: formatSiteExportUnit(detail.unite),
          qtePosee: detail.qtePosee,
          qteRebus: detail.qteRebus,
          qteRetour: detail.qteRetour,
          dateRetour: detail.dateRetour || '',
          observation: detail.observation,
          statut: normalizeDetailStatut(detail.statut),
        })),
      );
    }

    async function exportItems(fileNameOverride, lineFilterOverride) {
      if (!isSiteExportAllowed()) {
        updateSiteExportButtonState();
        return;
      }
      if (!currentSite) {
        UiService.navigate('index.html');
        return;
      }

      StorageService.recordExcelExportHistory(siteId, currentSite?.nom).catch(() => {});

      let rows = buildSiteExportRows();
      if (!rows.length) {
        try {
          detailRowsByItem = await StorageService.getDetailRowsBySite(siteId);
          rows = buildSiteExportRows();
        } catch (_error) {
          // On conserve le comportement actuel: un toast utilisateur si aucune donnée exploitable.
        }
      }
      if (!rows.length) {
        UiService.showToast('Aucune donnée');
        return;
      }

      const selectedLineFilter = String(lineFilterOverride || siteExportLineFilterSelect?.value || 'all').trim() || 'all';
      const filteredRows = rows.filter((row) => matchesStatusClassification(row, selectedLineFilter));
      if (!filteredRows.length) {
        UiService.showToast('Aucune donnée');
        return;
      }

      const sortedRows = [...filteredRows].sort((a, b) => {
        const designationA = String(a?.designation || '').trim();
        const designationB = String(b?.designation || '').trim();

        if (!designationA && !designationB) {
          return 0;
        }
        if (!designationA) {
          return 1;
        }
        if (!designationB) {
          return -1;
        }

        const byDesignation = designationA.localeCompare(designationB, 'fr', {
          sensitivity: 'base',
          numeric: true,
        });
        if (byDesignation !== 0) {
          return byDesignation;
        }

        const outA = String(a?.out || '').trim();
        const outB = String(b?.out || '').trim();
        const byOut = outA.localeCompare(outB, 'fr', {
          sensitivity: 'base',
          numeric: true,
        });
        if (byOut !== 0) {
          return byOut;
        }

        const codeA = String(a?.code || '').trim();
        const codeB = String(b?.code || '').trim();
        return codeA.localeCompare(codeB, 'fr', {
          sensitivity: 'base',
          numeric: true,
        });
      });

      const title = `SUIVI MATERIEL . ${currentSite.nom}`;
      const workbook = buildSiteExcelContent(title, sortedRows, currentSite?.nom);
      const defaultFileName = currentSite?.nom ? `SUIVI MATERIEL ${currentSite.nom}` : 'SUIVI MATERIEL';
      const fileName = buildPage2ExportFileName(fileNameOverride || defaultFileName, 'xlsx');
      downloadExcelFile(fileName, 'Export Excel', workbook);
      saveExportFileNameToHistory(fileName);
    }

    function isSiteExportAllowed() {
      return isFirebaseUserAuthenticated(firebaseAuth.currentUser);
    }

    function updateSiteExportButtonState(user = firebaseAuth.currentUser) {
      const isAuthenticated = isFirebaseUserAuthenticated(user);
      if (openExportItems) {
        openExportItems.disabled = !isAuthenticated;
        openExportItems.setAttribute('aria-disabled', isAuthenticated ? 'false' : 'true');
      }
      if (!isAuthenticated) {
        closeSiteExportDialog();
      }
      updateSiteExportSubmitState();
    }

    function updateSiteExportSubmitState() {
      if (!siteExportSubmitButton || !siteExportFileNameInput) {
        return;
      }
      const hasValue = Boolean(String(siteExportFileNameInput.value || '').trim());
      const isAuthenticated = isSiteExportAllowed();
      siteExportSubmitButton.disabled = !isAuthenticated || !hasValue;
      if (siteExportFileNameError) {
        siteExportFileNameError.textContent = hasValue ? '' : 'Veuillez entrer un nom de fichier.';
      }
    }

    function closeSiteExportDialog() {
      if (siteExportFileNameError) {
        siteExportFileNameError.textContent = '';
      }
      if (siteExportSubmitButton) {
        siteExportSubmitButton.disabled = !isSiteExportAllowed();
        siteExportSubmitButton.classList.remove('is-loading');
      }
      siteExportDialog?.close();
    }

    function openSiteExportDialog() {
      if (!isSiteExportAllowed()) {
        updateSiteExportButtonState();
        return;
      }
      if (!siteExportDialog || !siteExportFileNameInput) {
        exportItems();
        return;
      }
      const defaultName = currentSite?.nom ? `SUIVI MATERIEL ${currentSite.nom}` : 'SUIVI MATERIEL';
      siteExportFileNameInput.value = sanitizeExportFileName(defaultName);
      if (siteExportLineFilterSelect) {
        siteExportLineFilterSelect.value = 'all';
      }
      if (siteExportFileNameError) {
        siteExportFileNameError.textContent = '';
      }
      if (siteExportSubmitButton) {
        siteExportSubmitButton.classList.remove('is-loading');
      }
      updateSiteExportSubmitState();
      siteExportDialog.showModal();
      window.setTimeout(() => {
        siteExportFileNameInput.focus();
        siteExportFileNameInput.select();
      }, 40);
    }

    function ensureItemActionBottomSheet() {
      let overlay = document.getElementById('itemActionSheetOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'itemActionSheetOverlay';
      overlay.className = 'bottom-sheet-overlay item-action-sheet-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="bottom-sheet item-action-sheet" id="itemActionSheet" role="dialog" aria-modal="true" aria-label="Actions de l'élément">
          <div class="bottom-sheet__handle" aria-hidden="true"></div>
          <p class="item-action-sheet__title" id="itemActionSheetTitle">Actions</p>
          <div class="item-action-sheet__content">
            <button type="button" class="item-action-sheet__row" id="itemActionEditNameButton">
              <img src="Icon/crayon-de-blog.png" alt="" aria-hidden="true" class="item-action-sheet__icon" />
              <span>Modifier le nom</span>
            </button>
            <button type="button" class="item-action-sheet__row item-action-sheet__row--danger" id="itemActionDeleteButton">
              <img src="Icon/poubelle.png" alt="" aria-hidden="true" class="item-action-sheet__icon" />
              <span>Supprimer</span>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function ensureItemDeleteConfirmationDialog() {
      let overlay = document.getElementById('itemDeleteConfirmOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'itemDeleteConfirmOverlay';
      overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <article class="maintenance-card item-delete-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="itemDeleteConfirmTitle">
          <h3 id="itemDeleteConfirmTitle">Supprimer cet OUT ?</h3>
          <p id="itemDeleteConfirmText">Cette action peut être annulée depuis la notification.</p>
          <div class="modal-actions item-delete-confirm-actions">
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--cancel" id="itemDeleteCancelButton">Annuler</button>
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--danger" id="itemDeleteConfirmButton">Supprimer</button>
          </div>
        </article>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function askItemDeleteConfirmation(itemLabel) {
      const overlay = ensureItemDeleteConfirmationDialog();
      const text = overlay.querySelector('#itemDeleteConfirmText');
      const cancelButton = overlay.querySelector('#itemDeleteCancelButton');
      const confirmButton = overlay.querySelector('#itemDeleteConfirmButton');
      if (!text || !cancelButton || !confirmButton) {
        return Promise.resolve(false);
      }

      const title = overlay.querySelector('#itemDeleteConfirmTitle');
      const normalizedLabel = String(itemLabel || '').trim() || 'OUT inconnu';
      if (title) {
        title.textContent = activeSiteTab === 'purchases' ? `Supprimer ${normalizedLabel} ?` : `Supprimer cet ${normalizedLabel} ?`;
      }
      text.textContent = 'Confirmer si OUI .';

      return new Promise((resolve) => {
        const closeAnimationDurationMs = 170;
        let closeAnimationTimer = null;
        let isClosing = false;
        const cleanup = () => {
          if (closeAnimationTimer) {
            window.clearTimeout(closeAnimationTimer);
            closeAnimationTimer = null;
          }
          overlay.hidden = true;
          overlay.classList.remove('is-open');
          overlay.onclick = null;
          cancelButton.onclick = null;
          confirmButton.onclick = null;
          document.removeEventListener('keydown', handleKeyDown);
          itemActionState.closeConfirmation = null;
        };
        const close = (value) => {
          if (isClosing) {
            return;
          }
          isClosing = true;
          overlay.classList.remove('is-open');
          closeAnimationTimer = window.setTimeout(() => {
            cleanup();
            resolve(value);
          }, closeAnimationDurationMs);
        };
        const handleKeyDown = (event) => {
          if (event.key === 'Escape') {
            close(false);
          }
        };

        itemActionState.closeConfirmation = () => close(false);
        cancelButton.onclick = () => close(false);
        confirmButton.onclick = () => close(true);
        overlay.onclick = (event) => {
          if (event.target === overlay) {
            close(false);
          }
        };
        document.addEventListener('keydown', handleKeyDown);
        overlay.hidden = false;
        window.requestAnimationFrame(() => {
          overlay.classList.add('is-open');
        });
      });
    }

    function ensureOutDeleteLimitDialog() {
      let overlay = document.getElementById('outDeleteLimitOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'outDeleteLimitOverlay';
      overlay.className = 'maintenance-overlay item-delete-confirm-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <article class="maintenance-card item-delete-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="outDeleteLimitTitle">
          <h3 id="outDeleteLimitTitle">Limite de suppression atteinte</h3>
          <p>Vous avez atteint la limite de <strong>2 suppressions de OUT par jour</strong>.</p>
          <p>Veuillez réessayer demain.</p>
          <div class="modal-actions item-delete-confirm-actions">
            <button type="button" class="btn item-delete-confirm-button site-delete-forbidden-close-button" id="outDeleteLimitCloseButton">OK</button>
          </div>
        </article>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function showOutDeleteLimitDialog() {
      const overlay = ensureOutDeleteLimitDialog();
      const closeButton = overlay.querySelector('#outDeleteLimitCloseButton');
      if (!closeButton) {
        return;
      }

      const closeAnimationDurationMs = 170;
      let closeAnimationTimer = null;
      let isClosing = false;
      const cleanup = () => {
        if (closeAnimationTimer) {
          window.clearTimeout(closeAnimationTimer);
          closeAnimationTimer = null;
        }
        overlay.hidden = true;
        overlay.classList.remove('is-open');
        overlay.onclick = null;
        closeButton.onclick = null;
        document.removeEventListener('keydown', handleKeyDown);
      };
      const close = () => {
        if (isClosing) {
          return;
        }
        isClosing = true;
        overlay.classList.remove('is-open');
        closeAnimationTimer = window.setTimeout(cleanup, closeAnimationDurationMs);
      };
      const handleKeyDown = (event) => {
        if (event.key === 'Escape') {
          close();
        }
      };

      closeButton.onclick = close;
      overlay.onclick = (event) => {
        if (event.target === overlay) {
          close();
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      overlay.hidden = false;
      window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
      });
    }

    function closeActiveTransientLayer() {
      if (typeof itemActionState.closeConfirmation === 'function') {
        itemActionState.closeConfirmation();
        return true;
      }
      if (typeof itemActionState.closeSheet === 'function') {
        itemActionState.closeSheet({ fromPopState: true });
        return true;
      }
      return false;
    }

    window.addEventListener('popstate', () => {
      if (itemActionState.ignoreNextPopstate) {
        itemActionState.ignoreNextPopstate = false;
        return;
      }
      closeActiveTransientLayer();
    });

    let selectedPurchaseId = null;
    let selectedPurchaseData = null;
    let selectedOutItemId = null;

    function openItemActionSheet(itemId) {
      const overlay = ensureItemActionBottomSheet();
      const sheet = overlay.querySelector('#itemActionSheet');
      const title = overlay.querySelector('#itemActionSheetTitle');
      const editNameButton = overlay.querySelector('#itemActionEditNameButton');
      const deleteButton = overlay.querySelector('#itemActionDeleteButton');
      if (!sheet || !title || !editNameButton || !deleteButton) {
        return;
      }

      const isPurchaseActions = activeSiteTab === 'purchases';
      const activeItem = isPurchaseActions
        ? currentPurchases.find((item) => item.id === itemId)
        : currentItems.find((item) => item.id === itemId);
      if (!activeItem) {
        return;
      }

      itemActionState.activeItemId = itemId;
      title.textContent = isPurchaseActions
        ? (String(activeItem.designation || '').trim() || 'Achat matériel')
        : (String(activeItem.numero || '').trim() || 'Actions');
      deleteButton.hidden = Boolean(isPurchaseActions && !permissions?.isAdmin);
      const closeTransitionDurationMs = 280;

      const clearCloseListeners = () => {
        if (overlay.__closeTimerId) {
          window.clearTimeout(overlay.__closeTimerId);
          overlay.__closeTimerId = null;
        }
        if (overlay.__closeTransitionHandler) {
          overlay.removeEventListener('transitionend', overlay.__closeTransitionHandler);
          overlay.__closeTransitionHandler = null;
        }
      };

      const closeSheet = ({ fromPopState = false } = {}) =>
        new Promise((resolve) => {
          if (overlay.hidden) {
            resolve();
            return;
          }
          let isResolved = false;
          const finish = () => {
            if (isResolved) {
              return;
            }
            isResolved = true;
            clearCloseListeners();
            overlay.hidden = true;
            overlay.classList.remove('is-open');
            itemActionState.activeItemId = null;
            itemActionState.closeSheet = null;
            if (itemActionState.hasHistoryEntry && !fromPopState) {
              itemActionState.hasHistoryEntry = false;
              itemActionState.ignoreNextPopstate = true;
              window.history.back();
            } else if (fromPopState) {
              itemActionState.hasHistoryEntry = false;
            }
            resolve();
          };

          overlay.classList.remove('is-open');
          overlay.__closeTransitionHandler = (event) => {
            if (event.target !== overlay && event.target !== sheet) {
              return;
            }
            finish();
          };
          overlay.addEventListener('transitionend', overlay.__closeTransitionHandler);
          overlay.__closeTimerId = window.setTimeout(finish, closeTransitionDurationMs);
        });

      itemActionState.closeSheet = closeSheet;
      const openOutEditModal = (targetItem) => {
        openEditOutNameModal(targetItem);
      };
      editNameButton.onclick = async () => {
        await closeSheet();
        const targetItem = isPurchaseActions
          ? currentPurchases.find((item) => item.id === itemId)
          : currentItems.find((item) => item.id === itemId);
        if (!targetItem) {
          return;
        }
        if (isPurchaseActions) {
          if (canCurrentUserEditPurchase(targetItem)) {
            openEditPurchaseModal(targetItem);
          }
          return;
        }

        // Sécurise l'ordre de transition: fermeture complète du bottom-sheet avant ouverture du modal.
        document.body.classList.remove('sidebar-open');
        overlay.classList.remove('is-open');
        overlay.hidden = true;
        window.setTimeout(() => {
          openOutEditModal(targetItem);
        }, 30);
      };
      deleteButton.onclick = async () => {
        deleteButton.disabled = true;
        try {
          await closeSheet();
          selectedPurchaseId = isPurchaseActions ? itemId : null;
          selectedPurchaseData = isPurchaseActions ? activeItem : null;
          const shouldDelete = await askItemDeleteConfirmation(
            isPurchaseActions ? (activeItem.designation || 'achat matériel') : (activeItem.numero || 'cet élément'),
          );
          if (!shouldDelete) {
            return;
          }
          if (isPurchaseActions) {
            if (!permissions?.isAdmin) {
              UiService.showToast('Action non autorisée.');
              return;
            }
            try {
              await deleteDoc(doc(firebaseDb, 'sites', siteId, 'achatsMateriels', selectedPurchaseId));
              await loadPurchasesForCurrentSite();
              setActiveSiteTab('purchases');
              UiService.showToast('Achat matériel supprimé.');
            } catch (error) {
              console.error('Erreur suppression achat matériel :', error);
              UiService.showToast(error?.message || 'Suppression de l’achat matériel impossible.');
            }
            return;
          }
          const removedSnapshot = await StorageService.removeItem(siteId, itemId);
          if (removedSnapshot?.limitReached) {
            showOutDeleteLimitDialog();
            return;
          }
          if (!removedSnapshot) {
            UiService.showToast('Suppression impossible.');
            return;
          }
          UiService.showUndoSnackbar('Élément supprimé.', async () => {
            const restored = await StorageService.restoreItem(removedSnapshot);
            UiService.showToast(restored ? 'Suppression annulée.' : 'Restauration impossible.');
          });
        } finally {
          deleteButton.disabled = false;
        }
      };

      overlay.onclick = (event) => {
        if (event.target === overlay) {
          closeSheet();
        }
      };

      let touchStartY = null;
      sheet.ontouchstart = (event) => {
        touchStartY = event.touches[0]?.clientY ?? null;
      };
      sheet.ontouchend = (event) => {
        if (touchStartY === null) {
          return;
        }
        const touchEndY = event.changedTouches[0]?.clientY ?? touchStartY;
        if (touchEndY - touchStartY > 60) {
          closeSheet();
        }
        touchStartY = null;
      };

      overlay.hidden = false;
      clearCloseListeners();
      if (!itemActionState.hasHistoryEntry) {
        window.history.pushState({ itemActionSheet: true }, '');
        itemActionState.hasHistoryEntry = true;
      }
      window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
      });
    }

    function renderItems(options = {}) {
      const shouldFlashSearchMatches = Boolean(options?.flashSearchMatches);
      const query = itemSearchInput.value.trim().toUpperCase();
      const filteredItems = getFilteredOutItems(query);
      updateCursorFilterCounters();

      itemCount.innerHTML = `<span class="outs-number">${filteredItems.length}</span><span class="outs-label">OUT${filteredItems.length > 1 ? 'S' : ''}</span>`;

      if (!filteredItems.length) {
        if (query) {
          itemList.innerHTML = `
            <div class="empty-state empty-search-state">
              <img src="Icon/Stikers.png" alt="" aria-hidden="true" loading="lazy" decoding="async" />
              <div class="empty-text">Aucun N° OUT Ou Article correspond à votre recherche.</div>
            </div>
          `;
        } else {
          itemList.innerHTML = `
            <div class="empty-state empty-state--page2" role="status" aria-live="polite">
              <img src="Icon/boite.png" alt="" aria-hidden="true" loading="lazy" decoding="async" class="empty-state__icon" />
              <div class="empty-text">Aucune Article Disponible.</div>
            </div>
          `;
        }
        return;
      }

      const htmlParts = [];
      let previousLabel = null;
      filteredItems.forEach((item) => {
        const currentLabel = resolveItemPeriodLabel(item);
        if (currentLabel && currentLabel !== previousLabel) {
          htmlParts.push(renderListSeparator(currentLabel));
        }
        previousLabel = currentLabel;
        const createdBy = resolveActorLabel(item?.createdBy, userNamesById, item?.createdByName);
        const createdLabel = buildDateAndTimeLabel(item?.dateCreation || item?.dateModification);
        const detailCountForCard = getOutDetailCountForActiveFilter(item.id, query);
        const isCursorFilterActive = activeStatusFilter !== 'all' && !query;
        const isSearchUnread = query && !readSearchResults.has(String(item.id));
        const isCursorFilterUnread = isCursorFilterActive && !readCursorFilterOuts.has(String(item.id));
        const unreadClassName = (isCursorFilterUnread || isSearchUnread) ? ' list-card--search-unread' : '';
        htmlParts.push(`
            <article class="list-card${unreadClassName}" data-search-match="true" data-item-id="${escapeHtml(item.id)}">
              ${permissions.canDelete && !permissions.isLecture ? `<button class="list-card__menu-button" type="button" data-item-menu="${item.id}" aria-label="Plus d'actions" title="Plus d'actions"><img src="Icon/Trois point.png" alt="" aria-hidden="true" class="list-card__menu-icon" /></button>` : ''}
              <button class="list-card__button" type="button" data-item-open="${item.id}">
                <h3 class="list-card__title">${escapeHtml(item.numero)}</h3>
                <div class="list-card__meta">
                  <span class="list-card__meta-item list-card__meta-item--article"><img src="Icon/Article.png" alt="" aria-hidden="true" class="icon" /><span class="outs-count"><span class="outs-number">${detailCountForCard}</span><span class="outs-label">Article${detailCountForCard > 1 ? 's' : ''}</span></span></span>
                  <span class="list-card__meta-item"><img src="Icon/Date et Heure.png" alt="" aria-hidden="true" class="icon" /><span>Créé le ${escapeHtml(createdLabel)}</span></span>
                  <span class="list-card__meta-item"><img src="Icon/Utilisateur.png" alt="" aria-hidden="true" class="icon" /><span>${escapeHtml(createdBy)}</span></span>
                </div>
              </button>
            </article>
          `);
      });
      itemList.innerHTML = htmlParts.join('');

      if (query && shouldFlashSearchMatches) {
        const matchedCards = itemList.querySelectorAll('[data-search-match="true"]');
        matchedCards.forEach((card) => {
          card.classList.remove('list-card--search-flash');
          void card.offsetWidth;
          card.classList.add('list-card--search-flash');
          window.setTimeout(() => {
            card.classList.remove('list-card--search-flash');
          }, 1800);
        });
      }

      itemList.querySelectorAll('[data-item-open]').forEach((button) => {
        button.addEventListener('click', () => {
          const openedItemId = String(button.dataset.itemOpen || '');
          if (query) {
            readSearchResults.add(openedItemId);
            persistSearchReadIdsToStorage(readSearchResults);
          }
          if (activeStatusFilter !== 'all' && !query) {
            readCursorFilterOuts.add(openedItemId);
            persistCursorFilterReadIdsToStorage(readCursorFilterOuts);
          }
          const card = button.closest('.list-card');
          card?.classList.remove('list-card--search-unread');
          UiService.navigate(`page3.html?siteId=${encodeURIComponent(siteId)}&itemId=${encodeURIComponent(button.dataset.itemOpen)}&search=${encodeURIComponent(query)}`);
        });
      });

      itemList.querySelectorAll('[data-item-menu]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          openItemActionSheet(button.dataset.itemMenu);
        });
      });

      restoreOutPageScrollPosition();
    }

    function outMatchesSearch(item, query) {
      if (!query) {
        return true;
      }
      const outMatches = String(item.numero || '').toUpperCase().includes(query);
      if (outMatches) {
        return true;
      }
      const itemDesignations = detailDesignationsByItem[item.id] || [];
      return itemDesignations.some((designation) => String(designation || '').toUpperCase().includes(query));
    }

    function matchesStatusClassification(detail, filterKey) {
      const isKoStatus = normalizeDetailStatut(detail.statut) === 'K.O';
      if (filterKey === 'ko') {
        return isKoStatus;
      }
      if (isKoStatus) {
        return filterKey === 'all';
      }
      const ecart = computeEcart(detail);
      const qtePosee = normalizeQuantity(detail?.qtePosee);
      const qteRetour = normalizeQuantity(detail?.qteRetour);
      const qteRebus = normalizeQuantity(detail?.qteRebus);
      const hasActivity = !quantitiesAreEqual(qtePosee, 0) || !quantitiesAreEqual(qteRetour, 0) || !quantitiesAreEqual(qteRebus, 0);
      const isDone = isDetailCompleted(detail);
      const isAttention = hasActivity && !quantitiesAreEqual(ecart, 0);
      if (filterKey === 'done') {
        return isDone;
      }
      if (filterKey === 'fix') {
        return isAttention;
      }
      if (filterKey === 'todo') {
        return !isDone && !isAttention;
      }
      return true;
    }

    function itemMatchesStatusFilter(item, filterKey) {
      if (filterKey === 'all') {
        return true;
      }
      const detailRows = detailRowsByItem[item.id] || [];
      return detailRows.some((detail) => matchesStatusClassification(detail, filterKey));
    }

    function detailMatchesOutSearch(detail, query) {
      if (!query) {
        return true;
      }
      const designation = String(detail?.designation || '').toUpperCase();
      const code = String(detail?.code || '').toUpperCase();
      return designation.includes(query) || code.includes(query);
    }

    function detailMatchesOutCombinedFilters(detail, query, filterKey) {
      const matchSearch = detailMatchesOutSearch(detail, query);
      const matchFilter = matchesStatusClassification(detail, filterKey);
      return matchSearch && matchFilter;
    }

    function itemMatchesCombinedSearchAndStatus(item, query, filterKey) {
      const detailRows = detailRowsByItem[item.id] || [];
      return detailRows.some((detail) => detailMatchesOutCombinedFilters(detail, query, filterKey));
    }

    function getMatchingDetailCountForItem(item, searchText, filterKey) {
      const query = String(searchText || '').trim().toUpperCase();
      const normalizedFilterKey = filterKey || 'all';
      const detailRows = detailRowsByItem[item.id] || [];
      return detailRows.reduce((count, detail) => {
        const outMatchesQuery = query ? String(item.numero || '').toUpperCase().includes(query) : false;
        const matchSearch = !query || outMatchesQuery ? true : detailMatchesOutSearch(detail, query);
        const matchFilter = matchesStatusClassification(detail, normalizedFilterKey);
        return count + (matchSearch && matchFilter ? 1 : 0);
      }, 0);
    }

    function getOutDetailCountForActiveFilter(itemId, query) {
      const detailRows = detailRowsByItem[itemId] || [];
      if (activeStatusFilter === 'all' && !query) {
        return Number(detailCountsByItem[itemId] || 0);
      }
      const item = currentItems.find((entry) => String(entry?.id) === String(itemId));
      if (!item) {
        return detailRows.reduce((count, detail) => count + (detailMatchesOutCombinedFilters(detail, query, activeStatusFilter) ? 1 : 0), 0);
      }
      return getMatchingDetailCountForItem(item, query, activeStatusFilter);
    }

    function getMatchingOutArticles(articleList, searchText, cursorFilter) {
      const query = String(searchText || '').trim().toUpperCase();
      const filterKey = cursorFilter || 'all';
      return articleList.filter((item) => {
        const matchSearch = query ? outMatchesSearch(item, query) : true;
        let matchFilter = true;
        if (filterKey !== 'all') {
          if (!query) {
            matchFilter = itemMatchesStatusFilter(item, filterKey);
          } else {
            matchFilter = getMatchingDetailCountForItem(item, query, filterKey) > 0;
          }
        }
        return itemMatchesDateFilter(item, selectedDateFilter) && matchSearch && matchFilter;
      });
    }

    function getFilteredOutItems(query) {
      return getMatchingOutArticles(currentItems, query, activeStatusFilter);
    }

    function getTotalMatchingDetailCount(searchText, filterKey) {
      const query = String(searchText || '').trim().toUpperCase();
      const normalizedFilterKey = filterKey || 'all';
      return currentItems.reduce((total, item) => {
        if (!itemMatchesDateFilter(item, selectedDateFilter)) {
          return total;
        }
        if (!outMatchesSearch(item, query)) {
          return total;
        }

        const matchingDetailCount = getMatchingDetailCountForItem(item, query, normalizedFilterKey);

        return total + matchingDetailCount;
      }, 0);
    }

    function updateCursorFilterCounters() {
      const query = itemSearchInput.value;
      if (!itemStatusFilterOptions.length) {
        return;
      }
      const countsByFilterKey = {};
      itemStatusFilterOptions.forEach((option) => {
        const filterKey = option.dataset.itemStatusFilter || 'all';
        const count = getTotalMatchingDetailCount(query, filterKey);
        countsByFilterKey[filterKey] = count;
        const countNode = option.querySelector('.page2-filter-option__count');
        if (countNode) {
          countNode.textContent = String(count);
        }
      });
      updateItemProgressStatsCard(countsByFilterKey);
      enforceItemStatusFilterAvailability();
    }

    function updateItemProgressStatsCard(countsByFilterKey = {}) {
      if (!itemProgressStatsCard) {
        return;
      }
      const doneCount = Number(countsByFilterKey.done || 0);
      const todoCount = Number(countsByFilterKey.todo || 0);
      const fixCount = Number(countsByFilterKey.fix || 0);
      const koCount = Number(countsByFilterKey.ko || 0);
      const total = doneCount + todoCount + fixCount + koCount;

      itemProgressStatsCard.hidden = activeSiteTab !== 'outs' || total <= 0;
      if (itemProgressTotal) {
        itemProgressTotal.textContent = `Total • ${total} ARTICLE${total > 1 ? 'S' : ''}`;
      }
      if (total <= 0) {
        return;
      }

      const setProgress = (metaNode, fillNode, count) => {
        if (!metaNode || !fillNode) return;
        const percentage = Math.round((count / total) * 100);
        metaNode.textContent = `${count} • ${percentage}%`;
        fillNode.style.width = `${percentage}%`;
      };

      setProgress(itemProgressDoneMeta, itemProgressDoneFill, doneCount);
      setProgress(itemProgressTodoMeta, itemProgressTodoFill, todoCount);
      setProgress(itemProgressFixMeta, itemProgressFixFill, fixCount);
      setProgress(itemProgressKoMeta, itemProgressKoFill, koCount);
    }

    function enforceItemStatusFilterAvailability() {
      itemStatusFilterOptions.forEach((option) => {
        const count = Number(option.querySelector('.page2-filter-option__count')?.textContent || '0');
        const isDisabled = count <= 0;
        option.classList.toggle('is-disabled', isDisabled);
        option.disabled = isDisabled;
        option.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
      });
    }

    function syncItemStatusFilterUi() {
      itemStatusFilterButton?.classList.toggle('is-filtered', activeStatusFilter !== 'all');
      itemStatusFilterOptions.forEach((option) => {
        const isActive = option.dataset.itemStatusFilter === activeStatusFilter;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-checked', isActive ? 'true' : 'false');
      });
    }

    function closeItemStatusFilterMenu() {
      if (!itemStatusFilterMenu || !itemStatusFilterButton) return;
      itemStatusFilterMenu.hidden = true;
      itemStatusFilterButton.setAttribute('aria-expanded', 'false');
    }

    function updateItemStatusFilterVisibility(tabName) {
      const shouldShowStatusFilter = tabName === 'outs';
      itemStatusFilterMenuWrap?.classList.toggle('hidden', !shouldShowStatusFilter);
      if (!shouldShowStatusFilter) {
        closeItemStatusFilterMenu();
      }
    }

    function openItemStatusFilterMenu() {
      if (!itemStatusFilterMenu || !itemStatusFilterButton) return;
      itemStatusFilterMenu.hidden = false;
      itemStatusFilterButton.setAttribute('aria-expanded', 'true');
    }

    function setItemStatusFilter(filterKey) {
      const nextFilter = filterKey || 'all';
      const targetOption = itemStatusFilterOptions.find((option) => (option.dataset.itemStatusFilter || 'all') === nextFilter);
      if (targetOption?.classList.contains('is-disabled')) {
        return;
      }
      const previousFilter = activeStatusFilter;
      activeStatusFilter = nextFilter;
      if (nextFilter !== previousFilter) {
        siteDetailHistoryLogger.recordFilter(targetOption?.querySelector('.page2-filter-option__label')?.textContent || statusFilterLabelByKey[nextFilter] || 'Tous');
      }
      try {
        window.localStorage.setItem(cursorFilterActiveStorageKey, statusFilterLabelByKey[activeStatusFilter] || 'Tous');
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
      if (activeStatusFilter === 'all') {
        readCursorFilterOuts.clear();
        clearCursorFilterReadIdsStorage();
      }
      syncItemStatusFilterUi();
      renderItems();
    }

    const openCreateItem = document.querySelector('body[data-page="site-detail"] #openCreateItem');
    const createItemLabel = document.querySelector(
      'body[data-page="site-detail"] .site-detail-fab-label--create',
    );
    const siteDetailFabStack = document.querySelector('body[data-page="site-detail"] .site-detail-fab-stack');
    const siteTabButtons = Array.from(document.querySelectorAll('.bottom-nav-item'));
    const bottomNavigation = document.querySelector('.bottom-navigation');
    const outsTabContent = document.getElementById('outsTabContent');
    const purchasesTabContent = document.getElementById('purchasesTabContent');
    const purchasesTabButton = document.querySelector('[data-tab="purchases"]');
    const purchasesList = document.getElementById('purchasesList');
    const purchasesEmptyState = document.getElementById('purchasesEmptyState');
    let isAdminTabAllowed = Boolean(permissions?.isAdmin);
    let activeSiteTab = 'outs';
    const PURCHASE_SEARCH_PLACEHOLDER = 'Rechercher un achat matériel';
    const OUT_SEARCH_PLACEHOLDER = 'Rechercher (OUT ou article)';
    const activeTabStorageKey = `siteDetailActiveTab:${siteId || 'default'}`;
    let itemFormErrorTimeoutId = null;
    let itemNumberErrorClearTimer = null;
    let itemAvailabilityDebounceTimer = null;
    let hasBlockingItemNumberError = false;
    let itemStoreOtherHideTimer = null;
    const itemStoreOtherTransitionDurationMs = 200;
    const defaultPurchaseStoreSuggestions = ['ABC', 'SANIFER', 'AQUAMAD', 'OCEAN TRADE', 'MASTER TRADE', 'BATIMAX', 'METAPRO'];
    const purchaseStoreSuggestionsStorageKey = 'purchaseStoreSuggestions';
    let purchaseStoreSuggestionSource = buildPurchaseStoreSuggestionList(loadStoredPurchaseStoreSuggestions());
    let visiblePurchaseStoreSuggestions = [];
    let activePurchaseStoreSuggestionIndex = -1;
    const ITEM_DIALOG_MODE_CREATE = 'create';
    const ITEM_DIALOG_MODE_EDIT = 'edit';
    const ITEM_DIALOG_MODE_EDIT_PURCHASE = 'edit_purchase';
    let itemDialogMode = ITEM_DIALOG_MODE_CREATE;
    let editingItemId = null;
    let activeOutSearchQuery = (itemSearchInput.value || "").trim().toUpperCase();
    function readSearchReadIdsFromStorage() {
      try {
        const rawValue = window.localStorage.getItem(searchReadIdsStorageKey);
        const parsed = JSON.parse(rawValue || '[]');
        if (!Array.isArray(parsed)) {
          return new Set();
        }
        return new Set(parsed.map((value) => String(value || '')).filter(Boolean));
      } catch (_error) {
        return new Set();
      }
    }

    function persistSearchReadIdsToStorage(readIdsSet) {
      try {
        window.localStorage.setItem(searchReadIdsStorageKey, JSON.stringify(Array.from(readIdsSet)));
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function clearSearchReadIdsStorage() {
      try {
        window.localStorage.removeItem(searchReadIdsStorageKey);
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function readCursorFilterReadIdsFromStorage() {
      try {
        const rawValue = window.localStorage.getItem(cursorFilterReadOutsStorageKey);
        const parsed = JSON.parse(rawValue || '[]');
        if (!Array.isArray(parsed)) {
          return new Set();
        }
        return new Set(parsed.map((value) => String(value || '')).filter(Boolean));
      } catch (_error) {
        return new Set();
      }
    }

    function persistCursorFilterReadIdsToStorage(readIdsSet) {
      try {
        window.localStorage.setItem(cursorFilterReadOutsStorageKey, JSON.stringify(Array.from(readIdsSet)));
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function clearCursorFilterReadIdsStorage() {
      try {
        window.localStorage.removeItem(cursorFilterReadOutsStorageKey);
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    readCursorFilterReadIdsFromStorage().forEach((id) => readCursorFilterOuts.add(id));
    const readSearchResults = readSearchReadIdsFromStorage();

    function isFirebaseUserAuthenticated(user) {
      return Boolean(user?.uid);
    }

    function updateCreateItemButtonVisibility(user) {
      if (!openCreateItem && !createItemLabel) {
        return;
      }
      const isAuthenticated = isFirebaseUserAuthenticated(user);
      if (openCreateItem) {
        openCreateItem.hidden = !isAuthenticated;
        openCreateItem.style.display = isAuthenticated ? 'inline-flex' : 'none';
      }
      if (createItemLabel) {
        createItemLabel.hidden = !isAuthenticated;
        createItemLabel.style.display = isAuthenticated ? '' : 'none';
      }
      const createButtonRow = openCreateItem?.closest('[data-fab-row="create"]');
      if (createButtonRow) {
        createButtonRow.hidden = !isAuthenticated;
        createButtonRow.style.display = isAuthenticated ? '' : 'none';
      }
    }

    function updateSiteDetailFloatingOffsets() {
      if (!bottomNavigation) {
        document.body.style.setProperty('--page2-visible-bottom-nav-height', '0px');
        return;
      }
      const bottomNavigationStyle = window.getComputedStyle(bottomNavigation);
      const isBottomNavigationVisible = !bottomNavigation.hidden
        && !bottomNavigation.classList.contains('hidden')
        && bottomNavigationStyle.display !== 'none'
        && bottomNavigationStyle.visibility !== 'hidden';
      const bottomNavigationHeight = isBottomNavigationVisible
        ? bottomNavigation.getBoundingClientRect().height
        : 0;
      document.body.style.setProperty('--page2-visible-bottom-nav-height', `${bottomNavigationHeight}px`);
    }

    function updateTabsByRole() {
      isAdminTabAllowed = Boolean(permissions?.isAdmin);
      siteTabButtons.forEach((tabButton) => {
        tabButton.classList.toggle('hidden', !isAdminTabAllowed);
      });
      if (bottomNavigation) {
        bottomNavigation.classList.toggle('hidden', !isAdminTabAllowed);
      }
      if (purchasesTabButton) {
        purchasesTabButton.classList.toggle('hidden', !isAdminTabAllowed);
      }
      updateSiteDetailFloatingOffsets();
      if (!isAdminTabAllowed && activeSiteTab === 'purchases') {
        setActiveSiteTab('outs');
      }
    }

    function formatPurchaseDateLabel(purchase) {
      return buildDateAndTimeLabel(purchase?.createdAt || purchase?.dateAchat || purchase?.date || purchase?.dateCreation || purchase?.dateModification);
    }

    function getCurrentPurchaseActor() {
      return {
        id: String(permissions?.userId || firebaseAuth.currentUser?.uid || '').trim(),
        name: String(
          permissions?.username
          || firebaseAuth.currentUser?.displayName
          || firebaseAuth.currentUser?.email
          || 'Utilisateur',
        ).trim() || 'Utilisateur',
      };
    }

    function canCurrentUserEditPurchase(purchase) {
      if (permissions?.isAdmin) {
        return true;
      }
      const actor = getCurrentPurchaseActor();
      const creatorId = String(purchase?.createdBy || '').trim();
      return Boolean(actor.id && creatorId && actor.id === creatorId);
    }

    function buildPurchaseUpdatePayload(purchase, nextValues) {
      const updates = {};
      Object.entries(nextValues).forEach(([fieldName, value]) => {
        if (String(purchase?.[fieldName] ?? '').trim() !== String(value ?? '').trim()) {
          updates[fieldName] = value;
        }
      });
      if (!Object.keys(updates).length) {
        return null;
      }
      const actor = getCurrentPurchaseActor();
      return {
        ...updates,
        updatedAt: serverTimestamp(),
        updatedBy: actor.id || null,
        updatedByName: actor.name,
      };
    }

    function renderListSeparator(title) {
      return `
        <div class="list-separator" role="separator" aria-label="${escapeHtml(title)}">
          <span class="list-separator__label">${escapeHtml(title)}</span>
        </div>
      `;
    }

    function getSavedActiveSiteTab() {
      try {
        return window.localStorage.getItem(activeTabStorageKey);
      } catch (_error) {
        return null;
      }
    }

    function saveActiveSiteTab(tabName) {
      try {
        window.localStorage.setItem(activeTabStorageKey, tabName);
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
    }

    function renderPurchases() {
      const query = itemSearchInput.value.trim().toUpperCase();
      const purchases = currentPurchases.filter((purchase) => {
        if (!itemMatchesDateFilter({ dateCreation: purchase?.createdAt || purchase?.dateAchat || purchase?.date || purchase?.dateCreation || purchase?.dateModification }, selectedDateFilter)) {
          return false;
        }
        if (!query) {
          return true;
        }
        return [purchase?.designation, purchase?.store, purchase?.magasin]
          .some((value) => String(value || '').toUpperCase().includes(query));
      });

      if (activeSiteTab === 'purchases') {
        itemCount.innerHTML = `<span class="outs-number">${purchases.length}</span><span class="outs-label">${purchases.length > 1 ? 'Achats' : 'Achat'}</span>`;
      }

      if (!purchasesList) {
        console.error('#purchasesList introuvable');
        return;
      }

      if (!purchases.length) {
        purchasesList.innerHTML = '';
        purchasesEmptyState?.classList.remove('hidden');
        return;
      }

      purchasesEmptyState?.classList.add('hidden');
      const htmlParts = [];
      let previousLabel = null;
      purchases.forEach((purchase) => {
        const createdLabel = formatPurchaseDateLabel(purchase);
        const currentLabel = resolveItemPeriodLabel({
          dateCreation: purchase?.createdAt || purchase?.dateAchat || purchase?.date || purchase?.dateCreation || purchase?.dateModification,
        });
        if (currentLabel && currentLabel !== previousLabel) {
          htmlParts.push(renderListSeparator(currentLabel));
        }
        previousLabel = currentLabel;
        htmlParts.push(`
          <article class="list-card purchase-card" data-purchase-open="${escapeHtml(purchase.id)}" tabindex="0" role="button" aria-label="Voir le détail de ${escapeHtml(purchase?.designation || 'cet achat matériel')}">
            ${permissions.canDelete && !permissions.isLecture && canCurrentUserEditPurchase(purchase) ? `<button class="list-card__menu-button" type="button" data-purchase-menu="${purchase.id}" aria-label="Plus d'actions" title="Plus d'actions"><img src="Icon/Trois point.png" alt="" aria-hidden="true" class="list-card__menu-icon" /></button>` : ''}
            <div class="list-card__button">
              <div class="purchase-card__content">
                <div class="purchase-card__media" aria-hidden="true">
                  ${String(purchase?.imageUrl || '').trim()
                    ? `<img src="${escapeHtml(purchase.imageUrl)}" alt="Photo achat matériel" />`
                    : `<img src="${escapeHtml(DEFAULT_PURCHASE_IMAGE_SRC)}" alt="" aria-hidden="true" />`}
                </div>
                <div class="purchase-card__body">
                  <h3 class="list-card__title">${escapeHtml(purchase?.designation || '-')}</h3>
                  <p class="purchase-card__hint">Appuyez pour voir les détails</p>
                  <p class="purchase-card__date">Créé le ${escapeHtml(createdLabel)}</p>
                </div>
              </div>
            </div>
          </article>
        `);
      });
      purchasesList.innerHTML = htmlParts.join('');
      purchasesList.querySelectorAll('[data-purchase-open]').forEach((card) => {
        const openPurchaseDetail = () => {
          const purchaseId = String(card.dataset.purchaseOpen || '').trim();
          if (!purchaseId) return;
          UiService.navigate(`purchase-detail.html?siteId=${encodeURIComponent(siteId)}&purchaseId=${encodeURIComponent(purchaseId)}`);
        };
        card.addEventListener('click', openPurchaseDetail);
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPurchaseDetail();
          }
        });
      });
      purchasesList.querySelectorAll('[data-purchase-menu]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          openItemActionSheet(button.dataset.purchaseMenu);
        });
      });
    }

    async function loadPurchasesForCurrentSite() {
      currentPurchases = [];
      if (!siteId) {
        renderPurchases();
        return;
      }
      try {
        const purchasesQuery = query(
          collection(firebaseDb, 'sites', siteId, 'achatsMateriels'),
          orderBy('createdAt', 'desc'),
        );
        const snap = await getDocs(purchasesQuery);
        currentPurchases = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
      } catch (_error) {
        currentPurchases = [];
      }
      renderPurchases();
    }

    function renderActiveTabContent(options = {}) {
      if (activeSiteTab === 'purchases') {
        renderPurchases();
        return;
      }
      renderItems();
    }

    function updateFabByActiveTab(tabName) {
      if (openCreateItem) {
        openCreateItem.classList.remove('hidden');
        openCreateItem.onclick = tabName === 'outs'
          ? null
          : () => {
              openCreatePurchaseModal();
            };
        openCreateItem.setAttribute('aria-label', tabName === 'outs' ? 'Ajouter un numéro OUT' : 'Ajouter un achat matériel');
      }
      if (createItemLabel) {
        createItemLabel.classList.remove('hidden');
        createItemLabel.textContent = tabName === 'outs' ? 'Créer un OUT' : 'Ajouter un achat';
      }
      const createButtonRow = openCreateItem?.closest('[data-fab-row="create"]');
      if (createButtonRow) {
        createButtonRow.classList.remove('hidden');
      }
      if (siteDetailFabStack) {
        siteDetailFabStack.classList.remove('hidden');
      }
    }


    function updateHeaderExportButton(tabName) {
      const exportBtn = document.querySelector('#headerExportBtn');
      if (!exportBtn) {
        return;
      }
      exportBtn.classList.toggle('hidden', tabName === 'purchases');
    }

    function setActiveSiteTab(tabName) {
      const safeTabName = tabName === 'purchases' && isAdminTabAllowed ? 'purchases' : 'outs';
      activeSiteTab = safeTabName;
      siteTabButtons.forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.tab === safeTabName);
      });
      outsTabContent?.classList.toggle('hidden', safeTabName !== 'outs');
      purchasesTabContent?.classList.toggle('hidden', safeTabName !== 'purchases');
      itemSearchInput.placeholder = safeTabName === 'outs' ? OUT_SEARCH_PLACEHOLDER : PURCHASE_SEARCH_PLACEHOLDER;
      itemSearchInput.value = safeTabName === 'outs'
        ? (window.localStorage.getItem(searchStorageKey) || '')
        : '';
      if (safeTabName === 'outs') {
        const normalizedQuery = (itemSearchInput.value || '').trim().toUpperCase();
        activeOutSearchQuery = normalizedQuery;
        if (!normalizedQuery) {
          readSearchResults.clear();
          clearSearchReadIdsStorage();
        } else {
          readSearchResults.clear();
          readSearchReadIdsFromStorage().forEach((id) => readSearchResults.add(id));
        }
      }
      saveActiveSiteTab(safeTabName);
      if (safeTabName === 'outs') {
        itemCount.innerHTML = `<span class="outs-number">0</span><span class="outs-label">OUTS</span>`;
      } else {
        itemCount.innerHTML = `<span class="outs-number">0</span><span class="outs-label">Achat</span>`;
      }
      if (safeTabName === 'purchases' && itemProgressStatsCard) {
        itemProgressStatsCard.hidden = true;
      }
      updateItemStatusFilterVisibility(safeTabName);
      updateFabByActiveTab(safeTabName);
      updateHeaderExportButton(safeTabName);
      renderActiveTabContent();
    }

    function getItemNumberMaxLength() {
      return itemNumberInput.maxLength > 0 ? itemNumberInput.maxLength : null;
    }

    function normalizeItemNumberInput(rawValue) {
      const normalizedRawValue = String(rawValue || '').trim().replace(/^out-/i, '');
      const digitsOnly = normalizedRawValue.replace(/\D/g, '');
      const maxLength = getItemNumberMaxLength();
      if (!maxLength) {
        return digitsOnly;
      }
      return digitsOnly.slice(0, maxLength);
    }

    function updateItemStoreOtherVisibility(options = {}) {
      if (!itemStoreSelect || !itemStoreOtherGroup) {
        return;
      }
      const immediate = Boolean(options.immediate);
      const shouldShowOtherField = itemStoreSelect.value === 'Autre à préciser';
      if (itemStoreOtherHideTimer) {
        window.clearTimeout(itemStoreOtherHideTimer);
        itemStoreOtherHideTimer = null;
      }

      if (shouldShowOtherField) {
        itemStoreOtherGroup.hidden = false;
        itemStoreOtherGroup.classList.remove('is-hiding');
        window.requestAnimationFrame(() => {
          itemStoreOtherGroup.classList.add('is-visible');
        });
        return;
      }

      if (itemStoreOtherInput) {
        itemStoreOtherInput.value = '';
      }

      if (immediate || itemStoreOtherGroup.hidden) {
        itemStoreOtherGroup.classList.remove('is-visible', 'is-hiding');
        itemStoreOtherGroup.hidden = true;
        return;
      }

      itemStoreOtherGroup.classList.remove('is-visible');
      itemStoreOtherGroup.classList.add('is-hiding');
      itemStoreOtherHideTimer = window.setTimeout(() => {
        itemStoreOtherGroup.hidden = true;
        itemStoreOtherGroup.classList.remove('is-hiding');
        itemStoreOtherHideTimer = null;
      }, itemStoreOtherTransitionDurationMs);
    }

    function resolveItemStoreValue() {
      const selectedValue = String(itemStoreSelect?.value || '').trim();
      if (!selectedValue) {
        return 'None';
      }
      if (selectedValue === 'Autre à préciser') {
        const customStore = String(itemStoreOtherInput?.value || '').trim();
        return customStore || 'None';
      }
      return selectedValue;
    }

    function updateItemNumberCounter() {
      const maxLength = getItemNumberMaxLength();
      const currentLength = itemNumberInput.value.length;
      itemNumberCounter.textContent = `${currentLength} / ${maxLength ?? currentLength}`;

      itemNumberCounter.classList.remove('is-warning', 'is-limit');
      if (!maxLength || maxLength <= 0) {
        return;
      }

      const ratio = currentLength / maxLength;
      if (ratio >= 1) {
        itemNumberCounter.classList.add('is-limit');
      } else if (ratio >= 0.8) {
        itemNumberCounter.classList.add('is-warning');
      }
    }

    function clearItemFormError() {
      if (itemFormErrorTimeoutId) {
        window.clearTimeout(itemFormErrorTimeoutId);
        itemFormErrorTimeoutId = null;
      }
      itemFormError.textContent = '';
      itemFormError.style.color = '';
    }

    function clearItemNumberErrorState() {
      if (itemNumberErrorClearTimer) {
        window.clearTimeout(itemNumberErrorClearTimer);
        itemNumberErrorClearTimer = null;
      }
      itemNumberInput.classList.remove('is-error', 'is-shaking');
    }

    function clearItemStoreErrorState() {
      itemStoreError.textContent = '';
      itemStoreSelect.classList.remove('is-error', 'is-shaking');
      itemStoreOtherInput?.classList.remove('is-error', 'is-shaking');
    }

    function showItemStoreError(message = 'Veuillez sélectionner un magasin.') {
      itemStoreError.textContent = message;
      itemStoreSelect.classList.remove('is-shaking');
      void itemStoreSelect.offsetWidth;
      itemStoreSelect.classList.add('is-error', 'is-shaking');

      window.setTimeout(() => {
        clearItemStoreErrorState();
      }, 2300);
    }

    function showItemFormError(message, durationMs = 2300) {
      clearItemNumberErrorState();
      hasBlockingItemNumberError = true;
      setItemFormMessage(message, { autoClearMs: 2000 });
      itemNumberInput.classList.remove('is-shaking');
      // Force un reflow pour rejouer l'animation à chaque nouvelle erreur.
      void itemNumberInput.offsetWidth;
      itemNumberInput.classList.add('is-error', 'is-shaking');
      itemNumberErrorClearTimer = window.setTimeout(() => {
        clearItemNumberErrorState();
      }, durationMs);
    }

    function setItemFormMessage(message, options = {}) {
      const { isSuccess = false, autoClearMs = null } = options;
      clearItemFormError();
      itemFormError.textContent = message;
      itemFormError.style.color = isSuccess ? 'var(--success)' : 'var(--danger)';
      if (autoClearMs && autoClearMs > 0) {
        itemFormErrorTimeoutId = window.setTimeout(() => {
          itemFormError.textContent = '';
          itemFormError.style.color = '';
          itemFormErrorTimeoutId = null;
        }, autoClearMs);
      }
    }

    function setItemCreateButtonState() {
      const value = normalizeItemNumberInput(itemNumberInput.value.trim());
      const isValidLength = value.length >= 4;
      itemCreateSubmitButton.disabled = hasBlockingItemNumberError || !isValidLength;
    }

    function validateItemNumberAvailability() {
      const normalizedValue = normalizeItemNumberInput(itemNumberInput.value.trim());
      itemNumberInput.value = normalizedValue;

      if (!normalizedValue) {
        hasBlockingItemNumberError = false;
        clearItemNumberErrorState();
        clearItemFormError();
        setItemCreateButtonState();
        return;
      }

      if (normalizedValue.length < 4) {
        hasBlockingItemNumberError = true;
        clearItemNumberErrorState();
        setItemFormMessage('Le numéro OUT doit contenir au moins 4 caractères.');
        setItemCreateButtonState();
        return;
      }

      const fullOutName = `OUT-${normalizedValue}`;
      const exists = currentItems.some((item) => String(item?.numero || '').toUpperCase() === fullOutName.toUpperCase());

      if (exists) {
        hasBlockingItemNumberError = true;
        itemNumberInput.classList.add('is-error');
        itemNumberInput.classList.remove('is-shaking');
        setItemFormMessage('Ce numéro OUT existe déjà.');
      } else {
        hasBlockingItemNumberError = false;
        clearItemNumberErrorState();
        setItemFormMessage('Ce numéro OUT est disponible.', { isSuccess: true });
      }

      setItemCreateButtonState();
    }

    function setItemDialogMode(mode, targetItem = null) {
      itemDialogMode = [ITEM_DIALOG_MODE_EDIT, ITEM_DIALOG_MODE_EDIT_PURCHASE].includes(mode) ? mode : ITEM_DIALOG_MODE_CREATE;
      editingItemId = itemDialogMode === ITEM_DIALOG_MODE_CREATE ? null : targetItem?.id || null;
      itemDialog.classList.toggle('edit-out-modal', itemDialogMode === ITEM_DIALOG_MODE_EDIT);
      if (itemDialogTitle) {
        itemDialogTitle.textContent = itemDialogMode === ITEM_DIALOG_MODE_EDIT
          ? 'Modifier le nom OUT'
          : itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE
            ? 'Modifier l’achat matériel'
            : 'Nouveau numéro OUT';
      }
      if (itemNumberLabelText) {
        itemNumberLabelText.textContent = itemDialogMode === ITEM_DIALOG_MODE_CREATE ? 'Numéro OUT' : 'Nom';
      } else if (itemNumberLabel) {
        itemNumberLabel.textContent = itemDialogMode === ITEM_DIALOG_MODE_CREATE ? 'Numéro OUT' : 'Nom';
      }
      console.log('item-number-label innerHTML:', document.querySelector('#itemDialog .item-number-label')?.innerHTML);
      const defaultLabel = itemCreateSubmitButton?.querySelector('.btn-label-default');
      const loadingLabel = itemCreateSubmitButton?.querySelector('.btn-label-loading');
      const isEditMode = itemDialogMode === ITEM_DIALOG_MODE_EDIT || itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE;
      if (defaultLabel) {
        defaultLabel.textContent = isEditMode ? 'Enregistrer' : 'Créer';
      }
      if (loadingLabel) {
        loadingLabel.textContent = isEditMode ? 'Enregistrement...' : 'Création...';
      }
      if (itemDialogMode === ITEM_DIALOG_MODE_EDIT) {
        itemNumberInput.setAttribute('inputmode', 'numeric');
        itemNumberInput.setAttribute('pattern', '[0-9]*');
        itemNumberInput.placeholder = 'Exemple : 26050200';
        itemNumberInput.value = normalizeItemNumberInput(targetItem?.numero || '');
      } else if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
        itemNumberInput.setAttribute('inputmode', 'text');
        itemNumberInput.removeAttribute('pattern');
        itemNumberInput.placeholder = 'Nom achat matériel';
        itemNumberInput.value = String(targetItem?.designation || '').trim();
      } else {
        itemNumberInput.setAttribute('inputmode', 'numeric');
        itemNumberInput.setAttribute('pattern', '[0-9]*');
        itemNumberInput.placeholder = 'Exemple : 26050200';
      }
      const isCreateMode = itemDialogMode === ITEM_DIALOG_MODE_CREATE;
      itemStoreSelect?.closest('.input-group')?.toggleAttribute('hidden', !isCreateMode);
      if (!isCreateMode) {
        hideItemStoreOtherField({ immediate: true });
      }
      itemStoreOtherGroup?.toggleAttribute('hidden', !isCreateMode);
      updateItemNumberCounter();
    }

    updateCreateItemButtonVisibility(firebaseAuth.currentUser);
    updateTabsByRole();
    window.addEventListener('resize', updateSiteDetailFloatingOffsets, { passive: true });
    if (bottomNavigation && 'ResizeObserver' in window) {
      const bottomNavigationResizeObserver = new ResizeObserver(updateSiteDetailFloatingOffsets);
      bottomNavigationResizeObserver.observe(bottomNavigation);
    }
    const savedActiveTab = getSavedActiveSiteTab();
    setActiveSiteTab(savedActiveTab === 'purchases' ? 'purchases' : 'outs');
    loadPurchasesForCurrentSite();
    siteTabButtons.forEach((tab) => {
      tab.addEventListener('click', async () => {
        const targetTab = tab.dataset.tab;
        if (targetTab === 'purchases' && !isAdminTabAllowed) {
          setActiveSiteTab('outs');
          return;
        }
        if (targetTab === 'purchases') {
          await loadPurchasesForCurrentSite();
        }
        setActiveSiteTab(targetTab);
      });
    });
    onAuthStateChanged(firebaseAuth, (user) => {
      updateCreateItemButtonVisibility(user || null);
      updateSiteExportButtonState(user || null);
      updateTabsByRole();
    });

    openCreateItem?.addEventListener('click', (event) => {
      if (activeSiteTab === 'purchases') {
        event.preventDefault();
        openCreatePurchaseModal();
        return;
      }
      setItemDialogMode(ITEM_DIALOG_MODE_CREATE);
      itemForm.reset();
      clearItemFormError();
      clearItemNumberErrorState();
      hasBlockingItemNumberError = false;
      if (itemAvailabilityDebounceTimer) {
        window.clearTimeout(itemAvailabilityDebounceTimer);
        itemAvailabilityDebounceTimer = null;
      }
      itemCreateSubmitButton.disabled = false;
      itemCreateSubmitButton.classList.remove('is-loading');
      updateItemNumberCounter();
      updateItemStoreOtherVisibility({ immediate: true });
      itemDialog.showModal();
      itemNumberInput.focus();
    });

    cancelPurchaseBtn?.addEventListener('click', () => {
      purchaseModal?.close();
    });

    purchaseDesignation?.addEventListener('input', () => {
      if (purchaseDesignation.value.length > 25) {
        purchaseDesignation.value = purchaseDesignation.value.slice(0, 25);
      }
      updatePurchaseDesignationCounter();
      if (String(purchaseDesignation.value || '').trim()) {
        clearPurchaseFieldError(purchaseDesignation, purchaseDesignationError);
      }
    });

    purchaseQty?.addEventListener('input', () => {
      if (parseInt(purchaseQty.value, 10) > 9999) {
        purchaseQty.value = 9999;
      }
      const qty = Number(purchaseQty.value);
      if (qty > 0) {
        clearPurchaseFieldError(purchaseQty, purchaseQtyError);
      }
    });

    purchaseUnit?.addEventListener('change', () => {
      const unit = String(purchaseUnit.value || '').trim();
      if (['Pcs', 'm', 'Paquet'].includes(unit)) {
        clearPurchaseFieldError(purchaseUnit, purchaseUnitError);
      }
    });


    if (purchaseStore && purchaseStoreSuggestions) {
      purchaseStore.addEventListener('focus', () => {
        renderPurchaseStoreSuggestions(purchaseStore.value);
      });

      purchaseStore.addEventListener('input', () => {
        renderPurchaseStoreSuggestions(purchaseStore.value);
      });

      purchaseStore.addEventListener('keydown', (event) => {
        if (!visiblePurchaseStoreSuggestions.length) {
          return;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const nextIndex = activePurchaseStoreSuggestionIndex < visiblePurchaseStoreSuggestions.length - 1 ? activePurchaseStoreSuggestionIndex + 1 : 0;
          setActivePurchaseStoreSuggestion(nextIndex);
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const nextIndex = activePurchaseStoreSuggestionIndex > 0 ? activePurchaseStoreSuggestionIndex - 1 : visiblePurchaseStoreSuggestions.length - 1;
          setActivePurchaseStoreSuggestion(nextIndex);
          return;
        }

        if (event.key === 'Enter' && activePurchaseStoreSuggestionIndex >= 0) {
          event.preventDefault();
          applyPurchaseStoreSuggestion(visiblePurchaseStoreSuggestions[activePurchaseStoreSuggestionIndex]);
          return;
        }

        if (event.key === 'Escape') {
          hidePurchaseStoreSuggestions();
        }
      });

      purchaseStore.addEventListener('blur', () => {
        window.setTimeout(hidePurchaseStoreSuggestions, 140);
      });

      purchaseStoreSuggestions.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });

      purchaseStoreSuggestions.addEventListener('click', (event) => {
        const option = event.target.closest('[data-purchase-store-typeahead-index]');
        if (!option) {
          return;
        }
        const suggestion = visiblePurchaseStoreSuggestions[Number(option.dataset.purchaseStoreTypeaheadIndex)];
        applyPurchaseStoreSuggestion(suggestion);
      });
    }

    purchasePhotoInput?.addEventListener('change', () => {
      const file = purchasePhotoInput.files?.[0] || null;
      selectedPurchasePhotoFile = file;
      if (selectedPurchasePhotoPreviewUrl) {
        URL.revokeObjectURL(selectedPurchasePhotoPreviewUrl);
        selectedPurchasePhotoPreviewUrl = '';
      }
      if (!file) {
        purchasePhotoPreviewWrap?.classList.add('hidden');
        if (purchasePhotoPreview) {
          purchasePhotoPreview.src = '';
        }
        return;
      }
      selectedPurchasePhotoPreviewUrl = URL.createObjectURL(file);
      if (purchasePhotoPreview) {
        purchasePhotoPreview.src = selectedPurchasePhotoPreviewUrl;
      }
      purchasePhotoPreviewWrap?.classList.remove('hidden');
    });

    editPurchaseNameInput?.addEventListener('input', () => {
      clearEditPurchaseFieldError();
      if (editPurchaseNameInput.value.length > 25) {
        editPurchaseNameInput.value = editPurchaseNameInput.value.slice(0, 25);
      }
      updateEditPurchaseCounter();
    });

    editPurchaseRemarkInput?.addEventListener('input', () => {
      clearPurchaseFieldError(editPurchaseRemarkInput, editPurchaseRemarkError);
    });

    cancelEditPurchaseBtn?.addEventListener('click', () => {
      editPurchaseModal?.close();
    });

    editPurchaseForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!selectedPurchaseId || !editPurchaseNameInput) return;
      const newName = String(editPurchaseNameInput.value || '').trim();
      const newRemark = String(editPurchaseRemarkInput?.value || '').trim();
      if (!newName) {
        showEditPurchaseFieldError('Nom obligatoire');
        editPurchaseNameInput.focus();
        return;
      }
      clearEditPurchaseFieldError();
      clearPurchaseFieldError(editPurchaseRemarkInput, editPurchaseRemarkError);
      setEditPurchaseSubmitLoadingState(true);
      try {
        if (!canCurrentUserEditPurchase(selectedPurchaseData)) {
          showEditPurchaseFieldError('Action non autorisée.');
          return;
        }
        const updates = buildPurchaseUpdatePayload(selectedPurchaseData, {
          designation: newName,
          remarque: newRemark,
          remark: newRemark,
        });
        if (updates) {
          await updateDoc(
            doc(firebaseDb, 'sites', siteId, 'achatsMateriels', selectedPurchaseId),
            updates,
          );
        }
        editPurchaseModal?.close();
        await loadPurchasesForCurrentSite();
        setActiveSiteTab('purchases');
      } finally {
        setEditPurchaseSubmitLoadingState(false);
      }
    });

    editOutNameInput?.addEventListener('input', () => {
      clearEditOutNameFieldError();
      if (editOutNameInput.value.length > 25) {
        editOutNameInput.value = editOutNameInput.value.slice(0, 25);
      }
      const normalized = normalizeItemNumberInput(editOutNameInput.value);
      if (editOutNameInput.value !== normalized) {
        editOutNameInput.value = normalized;
      }
      updateEditOutNameCounter();
    });

    cancelEditOutNameBtn?.addEventListener('click', () => {
      editOutNameModal?.close();
    });

    editOutNameForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!selectedOutItemId || !editOutNameInput) return;
      const newName = normalizeItemNumberInput(editOutNameInput.value || '');
      editOutNameInput.value = newName;
      if (!newName) {
        showEditOutNameFieldError('Nom obligatoire');
        editOutNameInput.focus();
        return;
      }
      if (newName.length < 4) {
        showEditOutNameFieldError('Le nom doit contenir au moins 4 caractères.');
        editOutNameInput.focus();
        return;
      }
      clearEditOutNameFieldError();
      setEditOutNameSubmitLoadingState(true);
      try {
        const result = await StorageService.updateItemName(siteId, selectedOutItemId, newName);
        if (!result?.ok) {
          showEditOutNameFieldError(result?.reason === 'duplicate_out' ? 'Ce N° OUT existe déjà pour ce site.' : 'Modification impossible.');
          return;
        }
        editOutNameModal?.close();
        UiService.showToast('Nom OUT mis à jour.');
      } finally {
        setEditOutNameSubmitLoadingState(false);
      }
    });

    purchaseForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await savePurchase();
    });

    updatePurchaseDesignationCounter();

    itemStoreSelect?.addEventListener('change', () => {
      clearItemStoreErrorState();
      updateItemStoreOtherVisibility();
      setItemCreateButtonState();
    });

    itemStoreOtherInput?.addEventListener('input', () => {
      clearItemStoreErrorState();
      setItemCreateButtonState();
    });

    itemNumberInput.addEventListener('beforeinput', (event) => {
      if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
        return;
      }
      const maxLength = getItemNumberMaxLength();
      if (!maxLength || event.inputType.startsWith('delete')) {
        return;
      }

      const selectionStart = itemNumberInput.selectionStart ?? itemNumberInput.value.length;
      const selectionEnd = itemNumberInput.selectionEnd ?? itemNumberInput.value.length;
      const selectedLength = Math.max(0, selectionEnd - selectionStart);
      const nextAllowedLength = maxLength - (itemNumberInput.value.length - selectedLength);
      if (nextAllowedLength <= 0) {
        event.preventDefault();
      }
    });

    itemNumberInput.addEventListener('paste', (event) => {
      if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
        return;
      }
      const clipboardText = event.clipboardData?.getData('text') ?? '';
      const sanitizedClipboardText = String(clipboardText).replace(/\D/g, '');
      if (!sanitizedClipboardText) {
        event.preventDefault();
        updateItemNumberCounter();
        return;
      }

      event.preventDefault();
      const maxLength = getItemNumberMaxLength();
      const selectionStart = itemNumberInput.selectionStart ?? itemNumberInput.value.length;
      const selectionEnd = itemNumberInput.selectionEnd ?? itemNumberInput.value.length;
      const selectedLength = Math.max(0, selectionEnd - selectionStart);
      const remainingLength = maxLength
        ? Math.max(0, maxLength - (itemNumberInput.value.length - selectedLength))
        : sanitizedClipboardText.length;
      const insertedValue = sanitizedClipboardText.slice(0, remainingLength);
      itemNumberInput.setRangeText(insertedValue, selectionStart, selectionEnd, 'end');
      updateItemNumberCounter();
    });

    itemNumberInput.addEventListener('input', () => {
      if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
        updateItemNumberCounter();
        return;
      }
      const normalizedValue = normalizeItemNumberInput(itemNumberInput.value);
      if (itemNumberInput.value !== normalizedValue) {
        itemNumberInput.value = normalizedValue;
      }
      updateItemNumberCounter();
      if (itemAvailabilityDebounceTimer) {
        window.clearTimeout(itemAvailabilityDebounceTimer);
      }
      itemAvailabilityDebounceTimer = window.setTimeout(() => {
        validateItemNumberAvailability();
      }, 200);
    });
    updateItemNumberCounter();

    itemDialog.addEventListener('close', () => {
      clearItemFormError();
      clearItemNumberErrorState();
      clearItemStoreErrorState();
      hasBlockingItemNumberError = false;
      if (itemAvailabilityDebounceTimer) {
        window.clearTimeout(itemAvailabilityDebounceTimer);
        itemAvailabilityDebounceTimer = null;
      }
      itemCreateSubmitButton.classList.remove('is-loading');
      itemCreateSubmitButton.disabled = false;
      updateItemNumberCounter();
      updateItemStoreOtherVisibility({ immediate: true });
      setItemDialogMode(ITEM_DIALOG_MODE_CREATE);
      editingItemId = null;
    });

    updateSiteExportButtonState(firebaseAuth.currentUser);

    if (openExportItems) {
      openExportItems.addEventListener('click', openSiteExportDialog);
    }

    if (siteExportCancelButton) {
      siteExportCancelButton.addEventListener('click', closeSiteExportDialog);
    }

    if (siteExportDialog) {
      siteExportDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeSiteExportDialog();
      });
      siteExportDialog.addEventListener('click', (event) => {
        if (event.target === siteExportDialog) {
          closeSiteExportDialog();
        }
      });
    }

    if (siteExportFileNameInput) {
      siteExportFileNameInput.addEventListener('input', () => {
        updateSiteExportSubmitState();
      });
    }

    if (siteExportForm) {
      siteExportForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!isSiteExportAllowed()) {
          updateSiteExportButtonState();
          return;
        }
        if (!siteExportSubmitButton || siteExportSubmitButton.disabled) {
          return;
        }
        const fileName = String(siteExportFileNameInput?.value || '').trim();
        if (!fileName) {
          updateSiteExportSubmitState();
          return;
        }
        const selectedLineFilter = String(siteExportLineFilterSelect?.value || 'all').trim() || 'all';
        siteExportSubmitButton.disabled = true;
        siteExportSubmitButton.classList.add('is-loading');
        try {
          await exportItems(fileName, selectedLineFilter);
          closeSiteExportDialog();
        } catch (_error) {
          siteExportSubmitButton.disabled = false;
          siteExportSubmitButton.classList.remove('is-loading');
          UiService.showToast('Exportation impossible.');
        }
      });
    }

    if (siteDetailFabStack) {
      const siteDetailScrollContainer = document.querySelector('body[data-page="site-detail"] .page-content');
      siteDetailFabStack.classList.remove('is-scroll-hidden');
      siteDetailScrollContainer?.addEventListener('scroll', persistOutPageScrollPosition, { passive: true });
    }

    itemSearchInput.addEventListener('input', () => {
      const isOutSearchInput = activeSiteTab === 'outs';
      if (isOutSearchInput) {
        const searchValue = itemSearchInput.value;
        if (searchValue) {
          window.localStorage.setItem(searchStorageKey, searchValue);
          window.localStorage.setItem('page2_search_value', searchValue);
        } else {
          window.localStorage.removeItem(searchStorageKey);
          window.localStorage.removeItem('page2_search_value');
        }
        const normalizedQuery = (searchValue || '').trim().toUpperCase();
        const hasQueryChanged = normalizedQuery !== activeOutSearchQuery;
        activeOutSearchQuery = normalizedQuery;
        if (!normalizedQuery) {
          readSearchResults.clear();
          clearSearchReadIdsStorage();
        } else if (hasQueryChanged) {
          readSearchResults.clear();
          clearSearchReadIdsStorage();
        }
      }
      renderActiveTabContent({
        flashSearchMatches: isOutSearchInput,
      });
    });

    itemSearchInput.addEventListener('blur', () => {
      siteDetailHistoryLogger.recordSearchOnBlur(itemSearchInput.value);
    });

    if (itemStatusFilterButton && itemStatusFilterMenu && itemStatusFilterOptions.length) {
      syncItemStatusFilterUi();
      itemStatusFilterButton.addEventListener('click', () => {
        if (itemStatusFilterMenu.hidden) {
          openItemStatusFilterMenu();
        } else {
          closeItemStatusFilterMenu();
        }
      });
      itemStatusFilterOptions.forEach((option) => {
        option.addEventListener('click', () => {
          setItemStatusFilter(option.dataset.itemStatusFilter || 'all');
          closeItemStatusFilterMenu();
        });
      });
      document.addEventListener('click', (event) => {
        if (!itemStatusFilterMenu.hidden && !event.target.closest('.page2-filter-menu-wrap')) {
          closeItemStatusFilterMenu();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !itemStatusFilterMenu.hidden) {
          closeItemStatusFilterMenu();
          itemStatusFilterButton.focus();
        }
      });
    }

    if (itemDateFilter) {
      if (!itemDateFilter.querySelector(`option[value="${selectedDateFilter}"]`)) {
        selectedDateFilter = 'all';
      }
      itemDateFilter.value = selectedDateFilter;
      const updateFilterChipsState = () => {
        filterChipButtons.forEach((chip) => {
          chip.classList.toggle('is-active', chip.dataset.filterChip === selectedDateFilter);
        });
      };
      updateFilterChipsState();
      filterChipButtons.forEach((chip) => {
        chip.addEventListener('click', () => {
          const nextFilter = chip.dataset.filterChip || 'all';
          if (nextFilter === selectedDateFilter) {
            return;
          }
          selectedDateFilter = nextFilter;
          siteDetailHistoryLogger.recordFilter(chip.textContent || 'Tous');
          itemDateFilter.value = selectedDateFilter;
          window.localStorage.setItem(dateFilterStorageKey, selectedDateFilter);
          updateFilterChipsState();
          renderActiveTabContent();
        });
      });
      itemDateFilter.addEventListener('change', () => {
        selectedDateFilter = itemDateFilter.value || 'all';
        window.localStorage.setItem(dateFilterStorageKey, selectedDateFilter);
        updateFilterChipsState();
        renderActiveTabContent();
      });
    }

    itemForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (itemCreateSubmitButton.classList.contains('is-loading')) {
        return;
      }
      const value = itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE
        ? String(itemNumberInput.value || '').trim()
        : normalizeItemNumberInput(itemNumberInput.value.trim());
      itemNumberInput.value = value;
      const maxLength = getItemNumberMaxLength();
      if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
        if (!value) {
          showItemFormError('Veuillez entrer un nom d’achat matériel.');
          return;
        }
      } else if (itemDialogMode === ITEM_DIALOG_MODE_EDIT) {
        if (!value) {
          showItemFormError('Veuillez entrer un nom OUT.');
          return;
        }
        if (value.length < 4) {
          showItemFormError('Le nom doit contenir au moins 4 caractères.');
          return;
        }
        if (maxLength && value.length > maxLength) {
          showItemFormError(`Le nom OUT ne peut pas dépasser ${maxLength} caractères.`);
          return;
        }
      } else {
        if (!value) {
          showItemFormError('Veuillez remplir ce champ');
          return;
        }
        if (!/^\d+$/.test(value)) {
          showItemFormError('Veuillez saisir des chiffres uniquement.');
          return;
        }
        if (value.length < 4) {
          showItemFormError('Veuillez saisir au moins 4 chiffres.');
          return;
        }
        const selectedStoreValue = String(itemStoreSelect?.value || '').trim();
        if (!selectedStoreValue) {
          showItemStoreError('Veuillez sélectionner un magasin.');
          itemStoreSelect.focus();
          return;
        }
        if (selectedStoreValue === 'Autre à préciser') {
          const customStoreValue = String(itemStoreOtherInput?.value || '').trim();
          if (!customStoreValue) {
            showItemStoreError('Veuillez préciser le magasin.');
            itemStoreOtherInput?.classList.remove('is-shaking');
            void itemStoreOtherInput?.offsetWidth;
            itemStoreOtherInput?.classList.add('is-error', 'is-shaking');
            itemStoreOtherInput?.focus();
            return;
          }
        }
      }
      if (itemDialogMode === ITEM_DIALOG_MODE_CREATE) {
        const fullOutName = `OUT-${value}`;
        const exists = currentItems.some((item) => String(item?.numero || '').toUpperCase() === fullOutName.toUpperCase());
        if (exists) {
          showItemFormError('Ce numéro OUT existe déjà.');
          itemCreateSubmitButton.disabled = true;
          return;
        }
      }
      if (!permissions.canCreate) {
        showItemFormError('Action non autorisée.');
        return;
      }
      itemCreateSubmitButton.disabled = true;
      itemCreateSubmitButton.classList.add('is-loading');
      try {
        const result = itemDialogMode === ITEM_DIALOG_MODE_EDIT
          ? await StorageService.updateItemName(siteId, editingItemId, value)
          : itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE
            ? (() => {
              const targetPurchase = currentPurchases.find((purchase) => purchase.id === editingItemId);
              if (!canCurrentUserEditPurchase(targetPurchase)) {
                return { ok: false, reason: 'forbidden' };
              }
              const updates = buildPurchaseUpdatePayload(targetPurchase, { designation: value });
              return updates
                ? updateDoc(doc(firebaseDb, 'sites', siteId, 'achatsMateriels', editingItemId), updates).then(() => ({ ok: true }))
                : Promise.resolve({ ok: true, unchanged: true });
            })()
            : await StorageService.createItem(siteId, value, { magasin: resolveItemStoreValue() });
        if (!result?.ok) {
          showItemFormError(
            result?.reason === 'duplicate_out'
              ? 'Ce N° OUT existe déjà pour ce site.'
              : itemDialogMode === ITEM_DIALOG_MODE_EDIT
                ? 'Modification impossible.'
                : 'Veuillez saisir au moins 4 chiffres.',
          );
          return;
        }
        if (itemDialogMode === ITEM_DIALOG_MODE_EDIT && result?.unchanged) {
          itemDialog.close();
          return;
        }
        clearItemFormError();
        itemCreateSubmitButton.classList.remove('is-loading');
        itemCreateSubmitButton.disabled = false;
        itemDialog.close();
        if (itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE) {
          await loadPurchasesForCurrentSite();
          setActiveSiteTab('purchases');
        }
        UiService.showToast(itemDialogMode === ITEM_DIALOG_MODE_EDIT ? 'Nom OUT mis à jour.' : itemDialogMode === ITEM_DIALOG_MODE_EDIT_PURCHASE ? 'Achat matériel mis à jour.' : 'N° OUT ajouté .');
      } finally {
        if (itemDialog.open) {
          itemCreateSubmitButton.classList.remove('is-loading');
          itemCreateSubmitButton.disabled = false;
        }
      }
    });

    StorageService.subscribeSites((sites) => {
      currentSite = sites.find((site) => site.id === siteId) || currentSite;
      if (!currentSite) {
        UiService.navigate('index.html');
        return;
      }
      siteTitle.textContent = currentSite.nom;
    });

    StorageService.subscribeItems(
      siteId,
      (items) => {
        currentItems = items;
        renderActiveTabContent();
        if (itemDialog.open && itemDialogMode === ITEM_DIALOG_MODE_CREATE) {
          validateItemNumberAvailability();
        }
      },
      () => {
        UiService.showToast('Synchronisation  indisponible.');
      },
    );

    StorageService.subscribeDetailCounts(
      siteId,
      (counts) => {
        detailCountsByItem = counts;
        renderActiveTabContent();
      },
      () => {},
    );

    StorageService.subscribeDetailDesignations(
      siteId,
      (designationsByItem) => {
        detailDesignationsByItem = designationsByItem;
        renderActiveTabContent();
      },
      () => {},
    );

    StorageService.subscribeDetailRows(
      siteId,
      (rowsByItem) => {
        detailRowsByItem = rowsByItem;
        if (activeSiteTab === 'outs') {
          updateCursorFilterCounters();
          renderItems();
        }
      },
      () => {},
    );

    loadUserNames();
  }

  function initItemDetailPage(permissions) {
    initAuthRequiredNoticeCard();

    const params = UiService.getQueryParams();
    const siteId = params.get('siteId');
    const itemId = params.get('itemId');
    if (!siteId || !itemId) {
      UiService.navigate('index.html');
      return;
    }

    requireElement('itemBackButton').addEventListener('click', () => {
      UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
    });

    const detailForm = requireElement('detailForm');
    const detailFormSection = requireElement('detailFormSection');
    const detailFormError = requireElement('detailFormError');
    const detailFormModal = requireElement('detailFormModal');
    const openDetailFormButton = requireElement('openDetailFormButton');
    const itemDetailFabLabel = document.querySelector('body[data-page="item-detail"] #itemDetailFabLabel');
    const itemDetailFabRow = openDetailFormButton?.closest('[data-fab-row="create"]');
    const cancelDetailFormButton = requireElement('cancelDetailFormButton');
    const detailCreateSubmitButton = requireElement('detailCreateSubmitButton');
    const detailCount = requireElement('detailCount');
    const detailStore = requireElement('detailStore');
    const detailTableBody = requireElement('detailTableBody');
    const detailSearchInput = requireElement('detailSearchInput');
    const clearSearchBtn = document.querySelector('#clearSearchBtn');
    const detailFilterButton = document.querySelector('#detailFilterButton');
    const detailFilterMenu = document.querySelector('#detailFilterMenu');
    const detailFilterOptions = Array.from(document.querySelectorAll('[data-detail-filter]'));
    detailFilterOptions.forEach((option) => {
      option.dataset.filterLabel = option.querySelector('.page3-filter-option__label')?.textContent.trim() || option.textContent.trim();
    });
    const exportButton = requireElement('exportDetailsButton');
    const detailExportDialog = requireElement('detailExportDialog');
    const detailExportForm = requireElement('detailExportForm');
    const detailExportFileNameInput = requireElement('detailExportFileNameInput');
    const detailExportFileNameError = requireElement('detailExportFileNameError');
    const detailExportSubmitButton = requireElement('detailExportSubmitButton');
    const detailExportCancelButton = requireElement('detailExportCancelButton');
    const codeInput = requireElement('codeInput');
    const codeInputCounter = requireElement('codeInputCounter');
    const codeInputError = requireElement('codeInputError');
    const designationInput = requireElement('designationInput');
    const designationInputCounter = requireElement('designationInputCounter');
    const designationInputError = requireElement('designationInputError');
    const codeSuggestions = requireElement('codeSuggestions');
    const isAuthenticatedUser = Boolean(firebaseAuth.currentUser);
    const canEditDetails = permissions.canEdit && isAuthenticatedUser;

    setupZoomableDetailTable();

    let currentSite = StorageService.getSite(siteId);
    const detailHistoryLogger = createSearchAndFilterHistoryLogger(siteId, () => currentSite?.nom || '');
    let currentItem = StorageService.getItem(siteId, itemId);
    let currentDetails = [];
    let hasResolvedInitialDetails = false;
    let isDetailSkeletonVisible = false;
    let detailSkeletonTimerId = null;
    let animateNextTableRender = false;
    let codeSuggestionSource = [];
    let visibleCodeSuggestions = [];
    let activeSuggestionIndex = -1;
    let detailFormErrorTimeoutId = null;
    let codeInputErrorTimeoutId = null;
    let designationInputErrorTimeoutId = null;
    let codeInputErrorStateTimeoutId = null;
    let designationInputErrorStateTimeoutId = null;
    const cursorFilterActiveStorageKey = 'page2_cursor_filter_active';
    const detailFilterKeyByPage2Label = {
      'Tous': 'all',
      'À faire': 'todo',
      'À corriger': 'fix',
      'Complété': 'done',
      'K.O': 'ko',
    };
    const detailFilterLabelByKey = {
      all: 'Tous',
      todo: 'À faire',
      fix: 'À corriger',
      done: 'Complété',
      ko: 'K.O',
    };
    let activeDetailFilter = 'all';
    const page2SearchStorageKey = 'page2_search_value';
    let page2SearchValue = '';
    let page2CursorFilterLabel = 'Tous';
    try {
      page2SearchValue = String(window.localStorage.getItem(page2SearchStorageKey) || '').trim();
      page2CursorFilterLabel = window.localStorage.getItem(cursorFilterActiveStorageKey) || 'Tous';
    } catch (_error) {
      page2SearchValue = '';
      page2CursorFilterLabel = 'Tous';
    }
    const hasPage2CursorFilterContext = page2CursorFilterLabel !== 'Tous';
    const page2CursorFilterKey = hasPage2CursorFilterContext
      ? (detailFilterKeyByPage2Label[page2CursorFilterLabel] || 'all')
      : 'all';
    activeDetailFilter = page2CursorFilterKey;

    function setDetailModalOpenState(isOpen) {
      document.body.classList.toggle('item-detail-modal-open', isOpen);
    }

    function closeDetailModal() {
      if (!detailFormModal?.open) {
        setDetailModalOpenState(false);
        return;
      }
      detailFormModal.close();
      setDetailModalOpenState(false);
      hideCodeSuggestions();
      clearDetailFormError();
      clearDetailRequiredFieldErrors();
    }

    function openDetailModal() {
      if (!detailFormModal || !permissions.canCreate || permissions.isLecture) {
        return;
      }
      detailForm.reset();
      requireElement('uniteInput').value = getAutomaticUnit('');
      requireElement('statutInput').value = 'OK';
      setDetailFormSavingState(false);
      clearDetailFormError();
      clearDetailRequiredFieldErrors();
      updateDetailInputCounters();
      detailFormModal.showModal();
      setDetailModalOpenState(true);
      window.setTimeout(() => {
        codeInput?.focus();
      }, 60);
    }

    function setDetailFormSavingState(isSaving) {
      if (!detailCreateSubmitButton) {
        return;
      }
      detailCreateSubmitButton.disabled = isSaving;
      detailCreateSubmitButton.classList.toggle('is-loading', isSaving);
    }

    function getInputMaxLength(input) {
      return input?.maxLength > 0 ? input.maxLength : null;
    }

    function enforceInputMaxLength(input) {
      const maxLength = getInputMaxLength(input);
      if (!input || !maxLength || maxLength <= 0) {
        return;
      }
      if (input.value.length > maxLength) {
        input.value = input.value.slice(0, maxLength);
      }
    }

    function updateInputCharCounter(input, counter) {
      if (!input || !counter) {
        return;
      }
      enforceInputMaxLength(input);
      const maxLength = getInputMaxLength(input);
      const currentLength = input.value.length;
      counter.textContent = `${currentLength} / ${maxLength ?? currentLength}`;
      counter.classList.remove('is-warning', 'is-limit');
      if (!maxLength || maxLength <= 0) {
        return;
      }
      const ratio = currentLength / maxLength;
      if (ratio >= 1) {
        counter.classList.add('is-limit');
      } else if (ratio >= 0.8) {
        counter.classList.add('is-warning');
      }
    }

    function enforceMaxLengthOnBeforeInput(event, input) {
      const maxLength = getInputMaxLength(input);
      if (!input || !maxLength || event.inputType.startsWith('delete')) {
        return;
      }
      const selectionStart = input.selectionStart ?? input.value.length;
      const selectionEnd = input.selectionEnd ?? input.value.length;
      const selectedLength = Math.max(0, selectionEnd - selectionStart);
      const nextAllowedLength = maxLength - (input.value.length - selectedLength);
      if (nextAllowedLength <= 0) {
        event.preventDefault();
      }
    }

    function enforceMaxLengthOnPaste(event, input, counter) {
      if (!input) {
        return;
      }
      const maxLength = getInputMaxLength(input);
      if (!maxLength) {
        return;
      }
      const clipboardText = event.clipboardData?.getData('text') ?? '';
      event.preventDefault();

      const selectionStart = input.selectionStart ?? input.value.length;
      const selectionEnd = input.selectionEnd ?? input.value.length;
      const prefix = input.value.slice(0, selectionStart);
      const suffix = input.value.slice(selectionEnd);
      const remainingLength = maxLength - (prefix.length + suffix.length);
      if (remainingLength <= 0) {
        updateInputCharCounter(input, counter);
        return;
      }

      const insertedText = clipboardText.slice(0, remainingLength);
      const nextValue = `${prefix}${insertedText}${suffix}`;
      input.value = nextValue.slice(0, maxLength);
      const caretPosition = prefix.length + insertedText.length;
      input.setSelectionRange(caretPosition, caretPosition);
      updateInputCharCounter(input, counter);
    }

    function updateDetailInputCounters() {
      updateInputCharCounter(codeInput, codeInputCounter);
      updateInputCharCounter(designationInput, designationInputCounter);
    }

    function clearDetailFormError() {
      if (!detailFormError) {
        return;
      }
      if (detailFormErrorTimeoutId) {
        window.clearTimeout(detailFormErrorTimeoutId);
        detailFormErrorTimeoutId = null;
      }
      detailFormError.textContent = '';
    }

    function getDetailFieldElements(fieldName) {
      if (fieldName === 'code') {
        return { input: codeInput, error: codeInputError };
      }
      if (fieldName === 'designation') {
        return { input: designationInput, error: designationInputError };
      }
      return { input: null, error: null };
    }

    function clearDetailFieldErrorTimeout(fieldName) {
      if (fieldName === 'code' && codeInputErrorTimeoutId) {
        window.clearTimeout(codeInputErrorTimeoutId);
        codeInputErrorTimeoutId = null;
      }
      if (fieldName === 'designation' && designationInputErrorTimeoutId) {
        window.clearTimeout(designationInputErrorTimeoutId);
        designationInputErrorTimeoutId = null;
      }
    }

    function clearDetailFieldErrorStateTimeout(fieldName) {
      if (fieldName === 'code' && codeInputErrorStateTimeoutId) {
        window.clearTimeout(codeInputErrorStateTimeoutId);
        codeInputErrorStateTimeoutId = null;
      }
      if (fieldName === 'designation' && designationInputErrorStateTimeoutId) {
        window.clearTimeout(designationInputErrorStateTimeoutId);
        designationInputErrorStateTimeoutId = null;
      }
    }

    function clearDetailFieldErrorState(fieldName) {
      const { input, error } = getDetailFieldElements(fieldName);
      clearDetailFieldErrorTimeout(fieldName);
      clearDetailFieldErrorStateTimeout(fieldName);
      if (error) {
        error.textContent = '';
      }
      if (input) {
        input.classList.remove('is-error', 'is-shaking');
      }
    }

    function showDetailFieldError(fieldName, message, durationMs = 2400) {
      const { input, error } = getDetailFieldElements(fieldName);
      if (!input || !error) {
        return;
      }
      clearDetailFieldErrorState(fieldName);
      clearDetailFormError();
      error.textContent = message;
      input.classList.remove('is-shaking');
      void input.offsetWidth;
      input.classList.add('is-error', 'is-shaking');

      const errorTimeoutId = window.setTimeout(() => {
        error.textContent = '';
        if (fieldName === 'code') {
          codeInputErrorTimeoutId = null;
        } else if (fieldName === 'designation') {
          designationInputErrorTimeoutId = null;
        }
      }, durationMs);

      const errorStateTimeoutId = window.setTimeout(() => {
        input.classList.remove('is-error', 'is-shaking');
        if (fieldName === 'code') {
          codeInputErrorStateTimeoutId = null;
        } else if (fieldName === 'designation') {
          designationInputErrorStateTimeoutId = null;
        }
      }, durationMs);

      if (fieldName === 'code') {
        codeInputErrorTimeoutId = errorTimeoutId;
        codeInputErrorStateTimeoutId = errorStateTimeoutId;
      } else if (fieldName === 'designation') {
        designationInputErrorTimeoutId = errorTimeoutId;
        designationInputErrorStateTimeoutId = errorStateTimeoutId;
      }
    }

    function clearDetailRequiredFieldErrors() {
      clearDetailFieldErrorState('code');
      clearDetailFieldErrorState('designation');
    }

    function showDetailFormError(message) {
      if (!detailFormError) {
        return;
      }
      clearDetailFormError();
      detailFormError.textContent = message;
      detailFormErrorTimeoutId = window.setTimeout(() => {
        detailFormError.textContent = '';
        detailFormErrorTimeoutId = null;
      }, 2600);
    }

    function buildCodeSuggestionSource(details) {
      const suggestionsByCode = new Map();
      details.forEach((detail) => {
        const code = String(detail?.code || '').trim();
        if (!code) {
          return;
        }
        const designation = String(detail?.designation || '').trim();
        const key = code.toLowerCase();
        if (!suggestionsByCode.has(key)) {
          suggestionsByCode.set(key, { code, designation });
          return;
        }
        const existing = suggestionsByCode.get(key);
        if (!existing.designation && designation) {
          existing.designation = designation;
        }
      });

      return Array.from(suggestionsByCode.values())
        .sort((a, b) => a.code.localeCompare(b.code, 'fr', { sensitivity: 'base' }));
    }

    function getCodeMatches(query) {
      const normalizedQuery = String(query || '').trim().toLowerCase();
      if (!normalizedQuery) {
        return [];
      }

      return codeSuggestionSource
        .map((entry) => {
          const codeLower = entry.code.toLowerCase();
          const matchIndex = codeLower.indexOf(normalizedQuery);
          return { entry, matchIndex, startsWith: codeLower.startsWith(normalizedQuery) };
        })
        .filter((item) => item.matchIndex !== -1)
        .sort((a, b) => {
          if (a.startsWith !== b.startsWith) {
            return a.startsWith ? -1 : 1;
          }
          if (a.matchIndex !== b.matchIndex) {
            return a.matchIndex - b.matchIndex;
          }
          return a.entry.code.localeCompare(b.entry.code, 'fr', { sensitivity: 'base' });
        })
        .slice(0, 8)
        .map((item) => item.entry);
    }

    function buildHighlightedText(text, query) {
      const safeText = String(text || '');
      const normalizedQuery = String(query || '').trim();
      if (!normalizedQuery) {
        return escapeHtml(safeText);
      }

      const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
      return escapeHtml(safeText).replace(matcher, '<mark>$1</mark>');
    }

    function setActiveSuggestion(index) {
      activeSuggestionIndex = index;
      if (!codeSuggestions) {
        return;
      }

      codeSuggestions.querySelectorAll('.typeahead__option').forEach((option, optionIndex) => {
        const isActive = optionIndex === index;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          option.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function hideCodeSuggestions() {
      visibleCodeSuggestions = [];
      activeSuggestionIndex = -1;
      if (!codeSuggestions) {
        return;
      }
      codeSuggestions.hidden = true;
      codeSuggestions.style.display = 'none';
      codeSuggestions.innerHTML = '';
    }

    function applyCodeSuggestion(entry) {
      if (!entry || !codeInput || !designationInput) {
        return;
      }
      codeInput.value = entry.code;
      designationInput.value = entry.designation || '';
      updateDetailInputCounters();
      requireElement('uniteInput').value = getAutomaticUnit(designationInput.value);
      hideCodeSuggestions();
    }

    function renderCodeSuggestions(query) {
      if (!codeSuggestions) {
        return;
      }

      const normalizedQuery = String(query || '').trim();
      if (!normalizedQuery) {
        hideCodeSuggestions();
        return;
      }

      visibleCodeSuggestions = getCodeMatches(query);
      activeSuggestionIndex = -1;

      if (!visibleCodeSuggestions.length) {
        hideCodeSuggestions();
        return;
      }

      codeSuggestions.hidden = false;
      codeSuggestions.style.display = 'block';
      codeSuggestions.innerHTML = visibleCodeSuggestions
        .map(
          (entry, index) => `
            <button
              type="button"
              class="typeahead__option"
              role="option"
              data-typeahead-index="${index}"
              aria-selected="false"
            >
              <span class="typeahead__code">${buildHighlightedText(entry.code, query)}</span>
              <span class="typeahead__designation">${buildHighlightedText(entry.designation || 'Désignation indisponible', query)}</span>
            </button>
          `,
        )
        .join('');
    }

    async function refreshCodeSuggestionSource() {
      const details = await StorageService.getAllDetails();
      codeSuggestionSource = buildCodeSuggestionSource(details);
      if (document.activeElement === codeInput && String(codeInput.value || '').trim()) {
        renderCodeSuggestions(codeInput.value);
      }
    }

    if (!permissions.canDelete || permissions.isLecture) {
      document.querySelector('.data-table')?.classList.add('data-table--hide-action');
    }

    function isFirebaseUserAuthenticated(user) {
      return Boolean(user?.uid);
    }

    function updateDetailCreateButtonVisibility(user) {
      if (!openDetailFormButton) {
        return;
      }
      const isAuthenticated = isFirebaseUserAuthenticated(user);
      openDetailFormButton.hidden = !isAuthenticated;
      openDetailFormButton.style.display = isAuthenticated ? 'inline-flex' : 'none';
      if (itemDetailFabLabel) {
        itemDetailFabLabel.hidden = !isAuthenticated;
        itemDetailFabLabel.style.display = isAuthenticated ? '' : 'none';
      }
      if (itemDetailFabRow) {
        itemDetailFabRow.hidden = !isAuthenticated;
        itemDetailFabRow.style.display = isAuthenticated ? '' : 'none';
      }
    }

    if (!permissions.canCreate || permissions.isLecture) {
      detailFormSection.hidden = true;
    } else if (detailFormSection) {
      detailFormSection.hidden = false;
    }

    updateDetailCreateButtonVisibility(firebaseAuth.currentUser);
    onAuthStateChanged(firebaseAuth, (user) => {
      updateDetailCreateButtonVisibility(user || null);
      updateDetailExportButtonState(user || null);
    });

    function renderTitle() {
      const itemTitle = requireElement('itemTitle');
      if (!currentSite || !currentItem) {
        itemTitle.textContent = 'Chargement...';
        return;
      }
      itemTitle.innerHTML = '';
      const primaryLine = document.createElement('span');
      primaryLine.className = 'header-title__line header-title__line--primary';
      primaryLine.textContent = currentSite.nom;
      const secondaryLine = document.createElement('span');
      secondaryLine.className = 'header-title__line header-title__line--secondary';
      secondaryLine.textContent = currentItem.numero;
      itemTitle.append(primaryLine, secondaryLine);
    }

    function renderStoreLabel() {
      if (!detailStore) {
        return;
      }
      const rawStoreValue = String(currentItem?.magasin || '').trim();
      const normalizedStoreValue = rawStoreValue.toLowerCase();
      let displayValue = rawStoreValue;
      let badgeVariantClass = 'detail-store-badge--custom';

      if (!rawStoreValue || normalizedStoreValue === 'none' || normalizedStoreValue === 'null') {
        displayValue = 'Non défini';
        badgeVariantClass = 'detail-store-badge--undefined';
      } else if (normalizedStoreValue === 'tit i' || normalizedStoreValue === 'titan i') {
        displayValue = 'TITAN I';
        badgeVariantClass = 'detail-store-badge--tit-i';
      } else if (normalizedStoreValue === 'hag 36') {
        displayValue = 'HAG 36';
        badgeVariantClass = 'detail-store-badge--hag-36';
      } else if (normalizedStoreValue === 'by pass') {
        displayValue = 'BYPASS';
        badgeVariantClass = 'detail-store-badge--by-pass';
      }

      detailStore.textContent = '';
      const storeLabel = document.createElement('span');
      storeLabel.className = 'detail-store-label page3-info-label';
      storeLabel.textContent = 'Magasin :';
      const storeBadge = document.createElement('span');
      storeBadge.className = `detail-store-badge page3-store-badge badge ${badgeVariantClass}`;
      storeBadge.textContent = displayValue;
      detailStore.append(storeLabel, storeBadge);
    }

    function getSearchQuery() {
      return detailSearchInput ? detailSearchInput.value.trim().toLowerCase() : '';
    }

    function matchesSearchQuery(detail, query) {
      if (!query) {
        return true;
      }
      const normalizedQuery = String(query || '').trim().toLowerCase();
      const designation = String(detail?.designation || '').toLowerCase();
      const code = String(detail?.code || '').toLowerCase();
      return designation.includes(normalizedQuery) || code.includes(normalizedQuery);
    }


    function getHighlightedHtml(value, query) {
      const rawValue = String(value ?? '');
      const trimmedQuery = String(query || '').trim();
      if (!trimmedQuery) {
        return escapeHtml(rawValue);
      }
      const pattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'ig');
      return escapeHtml(rawValue).replace(pattern, '<span class="search-highlight">$1</span>');
    }

    function matchesDetailFilter(detail, filterKey) {
      const isKoStatus = normalizeDetailStatut(detail.statut) === 'K.O';
      if (filterKey === 'ko') {
        return isKoStatus;
      }
      if (isKoStatus) {
        return filterKey === 'all';
      }

      const ecart = computeEcart(detail);
      const qtePosee = normalizeQuantity(detail?.qtePosee);
      const qteRetour = normalizeQuantity(detail?.qteRetour);
      const qteRebus = normalizeQuantity(detail?.qteRebus);
      const hasActivity = !quantitiesAreEqual(qtePosee, 0) || !quantitiesAreEqual(qteRetour, 0) || !quantitiesAreEqual(qteRebus, 0);
      const isDone = isDetailCompleted(detail);
      const isAttention = hasActivity && !quantitiesAreEqual(ecart, 0);

      if (filterKey === 'done') {
        return isDone;
      }
      if (filterKey === 'fix') {
        return isAttention;
      }
      if (filterKey === 'todo') {
        return !isDone && !isAttention;
      }
      return true;
    }

    function getFilteredDetails(details) {
      const query = getSearchQuery();
      return details.filter((detail) => matchesSearchQuery(detail, query) && matchesDetailFilter(detail, activeDetailFilter));
    }

    function updateDetailFilterCounters(details) {
      if (!detailFilterOptions.length) {
        return;
      }
      detailFilterOptions.forEach((option) => {
        const filterKey = option.dataset.detailFilter || 'all';
        const count = details.filter((detail) => matchesDetailFilter(detail, filterKey)).length;
        const countNode = option.querySelector('.page3-filter-option__count');
        if (countNode) {
          countNode.textContent = String(count);
        }
      });
      enforceDetailFilterAvailability();
    }

    function enforceDetailFilterAvailability() {
      detailFilterOptions.forEach((option) => {
        const count = Number(option.querySelector('.page3-filter-option__count')?.textContent || '0');
        const isDisabled = count <= 0;
        option.classList.toggle('is-disabled', isDisabled);
        option.disabled = isDisabled;
        option.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
      });
    }

    function syncDetailFilterUi() {
      detailFilterButton?.classList.toggle('is-filtered', activeDetailFilter !== 'all');
      detailFilterOptions.forEach((option) => {
        const isActive = option.dataset.detailFilter === activeDetailFilter;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-checked', isActive ? 'true' : 'false');
      });
    }

    function setDetailFilter(filterKey) {
      const targetOption = detailFilterOptions.find((option) => (option.dataset.detailFilter || 'all') === filterKey);
      if (targetOption?.classList.contains('is-disabled')) {
        return;
      }
      const previousFilter = activeDetailFilter;
      activeDetailFilter = filterKey;
      if (filterKey !== previousFilter) {
        detailHistoryLogger.recordFilter(targetOption?.dataset.filterLabel || detailFilterLabelByKey[filterKey] || 'Tous');
      }
      try {
        window.localStorage.setItem(cursorFilterActiveStorageKey, detailFilterLabelByKey[activeDetailFilter] || 'Tous');
      } catch (_error) {
        // Ignore localStorage restrictions.
      }
      syncDetailFilterUi();
      renderTable();
    }

    function closeDetailFilterMenu() {
      if (!detailFilterMenu || !detailFilterButton) {
        return;
      }
      detailFilterMenu.hidden = true;
      detailFilterButton.setAttribute('aria-expanded', 'false');
    }

    function openDetailFilterMenu() {
      if (!detailFilterMenu || !detailFilterButton) {
        return;
      }
      detailFilterMenu.hidden = false;
      detailFilterButton.setAttribute('aria-expanded', 'true');
    }

    function updateCount(filteredCount, totalCount) {
      const countNumber = detailCount?.querySelector('.count-number');
      const countLabel = detailCount?.querySelector('.count-label');
      if (!countNumber || !countLabel) {
        return;
      }

      if (!hasResolvedInitialDetails || filteredCount === null || totalCount === null) {
        countNumber.textContent = '...';
        countLabel.textContent = 'Chargement...';
        return;
      }

      countNumber.textContent = String(filteredCount);
      if (filteredCount === totalCount) {
        countLabel.textContent = filteredCount > 1 ? 'Articles' : 'Article';
        return;
      }
      countLabel.textContent = `${filteredCount > 1 ? 'Articles' : 'Article'} / ${totalCount}`;
    }

    function isDetailExportAllowed() {
      return isFirebaseUserAuthenticated(firebaseAuth.currentUser);
    }

    function exportDetails(fileNameOverride) {
      if (!isDetailExportAllowed()) {
        updateDetailExportButtonState();
        return;
      }
      if (!currentItem || !currentSite) {
        UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
        return;
      }

      StorageService.recordExcelExportHistory(siteId, currentSite?.nom).catch(() => {});

      const filteredDetails = getFilteredDetails(currentDetails);
      if (!filteredDetails.length) {
        UiService.showToast('Aucune Article à exporter.');
        return;
      }

      const workbook = buildDetailExcelContent(`${currentSite.nom} · ${currentItem.numero}`, filteredDetails, currentSite?.nom);
      const fileName = buildPage2ExportFileName(currentSite?.nom, 'xlsx');
      downloadExcelFile(fileName, 'Export Excel', workbook);
      saveExportFileNameToHistory(fileName);
    }

    function updateDetailExportButtonState(user = firebaseAuth.currentUser) {
      const isAuthenticated = isFirebaseUserAuthenticated(user);
      if (exportButton) {
        exportButton.disabled = !isAuthenticated;
        exportButton.setAttribute('aria-disabled', isAuthenticated ? 'false' : 'true');
      }
      if (!isAuthenticated) {
        closeDetailExportDialog();
      }
      updateDetailExportSubmitState();
    }

    function updateDetailExportSubmitState() {
      if (!detailExportSubmitButton || !detailExportFileNameInput) {
        return;
      }
      const hasValue = Boolean(String(detailExportFileNameInput.value || '').trim());
      const isAuthenticated = isDetailExportAllowed();
      detailExportSubmitButton.disabled = !isAuthenticated || !hasValue;
      if (detailExportFileNameError) {
        detailExportFileNameError.textContent = hasValue ? '' : 'Veuillez entrer un nom de fichier.';
      }
    }

    function closeDetailExportDialog() {
      if (detailExportFileNameError) {
        detailExportFileNameError.textContent = '';
      }
      if (detailExportSubmitButton) {
        detailExportSubmitButton.disabled = !isDetailExportAllowed();
        detailExportSubmitButton.classList.remove('is-loading');
      }
      detailExportDialog?.close();
    }

    function openDetailExportDialog() {
      if (!isDetailExportAllowed()) {
        updateDetailExportButtonState();
        return;
      }
      if (!detailExportDialog || !detailExportFileNameInput) {
        exportDetails();
        return;
      }
      const defaultName = currentSite?.nom && currentItem?.numero
        ? `${currentSite.nom} · ${currentItem.numero}`
        : 'export-materiel';
      detailExportFileNameInput.value = sanitizeExportFileName(defaultName);
      if (detailExportFileNameError) {
        detailExportFileNameError.textContent = '';
      }
      if (detailExportSubmitButton) {
        detailExportSubmitButton.classList.remove('is-loading');
      }
      updateDetailExportSubmitState();
      detailExportDialog.showModal();
      window.setTimeout(() => {
        detailExportFileNameInput.focus();
        detailExportFileNameInput.select();
      }, 40);
    }

    function ensureDetailDeleteConfirmationDialog() {
      let overlay = document.getElementById('detailDeleteConfirmOverlay');
      if (overlay) {
        return overlay;
      }

      overlay = document.createElement('div');
      overlay.id = 'detailDeleteConfirmOverlay';
      overlay.className = 'maintenance-overlay item-delete-confirm-overlay detail-delete-confirm-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <article class="maintenance-card item-delete-confirm-card detail-delete-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="detailDeleteConfirmTitle">
          <h3 id="detailDeleteConfirmTitle">Supprimer cette donnée ?</h3>
          <p id="detailDeleteConfirmText">Cette action est définitive.</p>
          <div class="modal-actions item-delete-confirm-actions detail-delete-confirm-actions">
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--cancel" id="detailDeleteCancelButton">Annuler</button>
            <button type="button" class="btn item-delete-confirm-button item-delete-confirm-button--danger detail-delete-confirm-submit" id="detailDeleteConfirmButton">
              <span class="btn-label-default">Supprimer</span>
              <span class="btn-loading-spinner" aria-hidden="true"></span>
              <span class="btn-label-loading" aria-hidden="true">Suppression...</span>
            </button>
          </div>
        </article>
      `;
      document.body.appendChild(overlay);
      return overlay;
    }

    function askDetailDeleteConfirmation(detailId) {
      const overlay = ensureDetailDeleteConfirmationDialog();
      const cancelButton = overlay.querySelector('#detailDeleteCancelButton');
      const confirmButton = overlay.querySelector('#detailDeleteConfirmButton');
      if (!cancelButton || !confirmButton) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        const closeAnimationDurationMs = 170;
        let closeAnimationTimer = null;
        let isClosing = false;
        let isDeleting = false;

        const setLoadingState = (isLoading) => {
          confirmButton.disabled = isLoading;
          confirmButton.classList.toggle('is-loading', isLoading);
          cancelButton.disabled = isLoading;
        };

        const cleanup = () => {
          if (closeAnimationTimer) {
            window.clearTimeout(closeAnimationTimer);
            closeAnimationTimer = null;
          }
          setLoadingState(false);
          overlay.hidden = true;
          overlay.classList.remove('is-open');
          overlay.onclick = null;
          cancelButton.onclick = null;
          confirmButton.onclick = null;
          document.removeEventListener('keydown', handleKeyDown);
        };

        const close = () => {
          if (isClosing) {
            return;
          }
          isClosing = true;
          overlay.classList.remove('is-open');
          closeAnimationTimer = window.setTimeout(() => {
            cleanup();
            resolve();
          }, closeAnimationDurationMs);
        };

        const handleKeyDown = (event) => {
          if (event.key === 'Escape' && !isDeleting) {
            close();
          }
        };

        cancelButton.onclick = () => {
          if (!isDeleting) {
            close();
          }
        };

        confirmButton.onclick = async () => {
          if (isDeleting) {
            return;
          }
          isDeleting = true;
          setLoadingState(true);
          const removed = await StorageService.removeDetail(siteId, itemId, detailId);
          UiService.showToast(removed ? 'Article supprimée.' : 'Suppression impossible.');
          if (removed) {
            close();
            return;
          }
          isDeleting = false;
          setLoadingState(false);
        };

        overlay.onclick = (event) => {
          if (event.target === overlay && !isDeleting) {
            close();
          }
        };
        document.addEventListener('keydown', handleKeyDown);
        overlay.hidden = false;
        window.requestAnimationFrame(() => {
          overlay.classList.add('is-open');
        });
      });
    }

    function setRowKoInteractionState(row, isKoStatus) {
      if (!row) {
        return;
      }

      const editableFields = row.querySelectorAll('[data-field]');
      editableFields.forEach((field) => {
        const fieldName = field.dataset.field;
        const shouldDisable = !canEditDetails || (isKoStatus && fieldName !== 'statut');
        field.disabled = shouldDisable;
        field.readOnly = shouldDisable && field.tagName === 'INPUT';
        field.tabIndex = shouldDisable ? -1 : 0;
        field.classList.toggle('cell-input--soft-disabled', shouldDisable);
        field.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
      });
    }

    function applyDetailRowSemanticState(row) {
      if (!row) {
        return;
      }

      const isKoStatus = normalizeDetailStatut(row.querySelector('[data-field="statut"]')?.value) === 'K.O';
      const detail = {
        qteSortie: row.querySelector('[data-field="qteSortie"]')?.value,
        qtePosee: row.querySelector('[data-field="qtePosee"]')?.value,
        qteRetour: row.querySelector('[data-field="qteRetour"]')?.value,
        qteRebus: row.querySelector('[data-field="qteRebus"]')?.value,
      };
      const qtePosee = normalizeQuantity(detail.qtePosee);
      const qteRetour = normalizeQuantity(detail.qteRetour);
      const qteRebus = normalizeQuantity(detail.qteRebus);
      const ecart = getEcartNumericValue(row.querySelector('[data-col-key="ecart"]'));
      const hasActivity = !quantitiesAreEqual(qtePosee, 0) || !quantitiesAreEqual(qteRetour, 0) || !quantitiesAreEqual(qteRebus, 0);
      const isDone = isDetailCompleted(detail);

      row.classList.toggle('detail-row--done', !isKoStatus && isDone);
      row.classList.toggle('detail-row--attention', !isKoStatus && hasActivity && !quantitiesAreEqual(ecart, 0));
    }

    function renderTable() {
      if (!hasResolvedInitialDetails) {
        updateCount(null, null);
        detailTableBody.innerHTML = `<tr><td colspan="15"><div class="empty-state">Chargement...</div></td></tr>`;
        return;
      }

      if (!currentItem) {
        UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
        return;
      }

      const filteredDetails = getFilteredDetails(currentDetails);
      const searchQuery = getSearchQuery();
      updateCount(filteredDetails.length, currentDetails.length);
      updateDetailFilterCounters(currentDetails);

      if (!filteredDetails.length) {
        detailTableBody.innerHTML = `<tr><td colspan="15"><div class="empty-state">${currentDetails.length ? 'Aucune  désignation ne correspond à votre recherche.' : 'Aucune article enregistrée.'}</div></td></tr>`;
        return;
      }

      detailTableBody.innerHTML = filteredDetails
        .map(
          (detail, index) => {
            const ecart = computeEcart(detail);
            const ecartClassName = typeof ecart === 'number' && !quantitiesAreEqual(ecart, 0) ? ' cell-input--ecart-alert' : '';
            const enterAnimationStyle = animateNextTableRender ? ` style="--detail-row-enter-delay:${Math.min(index, 5) * 40}ms"` : '';
            const isKoStatus = normalizeDetailStatut(detail.statut) === 'K.O';
            const rowClasses = [
              animateNextTableRender ? 'detail-row-enter' : '',
              isKoStatus ? 'detail-row--ko' : '',
            ].filter(Boolean).join(' ');
            return `
            <tr data-detail-id="${detail.id}" class="${rowClasses}"${enterAnimationStyle}>
              <td><span class="field-badge">${getHighlightedHtml(detail.champ, searchQuery)}</span></td>
              <td><input class="cell-input cell-input--compact-dynamic cell-input--left" data-col-key="code" data-field="code" type="text" maxlength="120" value="${escapeHtml(detail.code)}" /></td>
              <td><textarea class="cell-input cell-textarea cell-input--autosize cell-input--designation designation-field cell-input--left" data-field="designation" maxlength="120" rows="1">${escapeHtml(detail.designation)}</textarea></td>
              <td><input class="cell-input cell-input--compact-dynamic" data-col-key="qteSortie" data-field="qteSortie" type="text" inputmode="decimal" maxlength="120" value="${escapeHtml(formatEditableQuantityValue(detail.qteSortie))}" /></td>
              <td><span class="meta-value">${getHighlightedHtml(detail.unite, searchQuery)}</span></td>
              <td><input class="cell-input cell-input--compact-dynamic" data-col-key="qtePosee" data-field="qtePosee" type="text" inputmode="decimal" maxlength="120" value="${escapeHtml(formatEditableQuantityValue(detail.qtePosee))}" /></td>
              <td><input class="cell-input cell-input--compact-dynamic" data-col-key="qteRebus" data-field="qteRebus" type="text" inputmode="decimal" maxlength="120" value="${escapeHtml(formatEditableQuantityValue(detail.qteRebus))}" /></td>
              <td><input class="cell-input cell-input--compact-dynamic" data-col-key="qteRetour" data-field="qteRetour" type="text" inputmode="decimal" maxlength="120" value="${escapeHtml(formatEditableQuantityValue(detail.qteRetour))}" /></td>
              <td><input class="cell-input cell-input--compact-dynamic date-retour-field" data-col-key="dateRetour" data-field="dateRetour" type="date" value="${escapeHtml(detail.dateRetour || '')}" /></td>
              <td><input class="cell-input cell-input--compact-dynamic${ecartClassName}" data-col-key="ecart" type="text" maxlength="120" value="${formatEcartDisplay(ecart)}" data-ecart-value="${ecart}" readonly aria-label="Ecart" /></td>
              <td><input data-col-key="observation" data-field="observation" type="text" maxlength="120" class="cell-input cell-input--compact-dynamic" value="${escapeHtml(detail.observation)}" /></td>
              <td>
                <div class="detail-status-field detail-status-field--${isKoStatus ? 'ko' : 'ok'}">
                  <select class="cell-input cell-input--compact-dynamic detail-status-select" data-col-key="statut" data-field="statut" aria-label="Statut">
                    <option value="OK" ${!isKoStatus ? 'selected' : ''}>OK</option>
                    <option value="K.O" ${isKoStatus ? 'selected' : ''}>K.O</option>
                  </select>
                </div>
              </td>
              <td><span class="meta-value">${getHighlightedHtml(UiService.formatDate(detail.dateCreation), searchQuery)}</span></td>
              <td><span class="meta-value">${getHighlightedHtml(UiService.formatDate(detail.dateModification), searchQuery)}</span></td>
              <td>
                ${permissions.canDelete && !permissions.isLecture
      ? `<button class="table-delete-icon-button" type="button" data-detail-delete="${detail.id}" aria-label="Supprimer" title="Supprimer"><img src="Icon/poubelle.png" alt="" aria-hidden="true" class="table-delete-icon-button__icon" /></button>`
      : ""}
              </td>
            </tr>
          `;
          },
        )
        .join('');
      animateNextTableRender = false;

      detailTableBody.querySelectorAll('tr[data-detail-id]').forEach((row) => {
        const statusSelect = row.querySelector('[data-field="statut"]');
        const isKoStatus = normalizeDetailStatut(statusSelect?.value) === 'K.O';
        setRowKoInteractionState(row, isKoStatus);
        applyDetailRowSemanticState(row);
      });

      const editableQuantityFields = new Set(['qteSortie', 'qtePosee', 'qteRebus', 'qteRetour']);

      detailTableBody.querySelectorAll('[data-field]').forEach((field) => {
        if (editableQuantityFields.has(field.dataset.field)) {
          field.addEventListener('blur', () => {
            normalizeEmptyQuantityInputValue(field);
          });
        }

        field.addEventListener('change', async (event) => {
          const row = event.target.closest('tr');
          const fieldName = event.target.dataset.field;
          const currentDetail = currentDetails.find((detail) => detail.id === row.dataset.detailId);

          if (!currentDetail) {
            return;
          }

          const isKoRow = normalizeDetailStatut(currentDetail.statut) === 'K.O';
          if (fieldName !== 'statut' && isKoRow) {
            return;
          }

          const nextValue = fieldName === 'statut'
            ? normalizeDetailStatut(event.target.value)
            : editableQuantityFields.has(fieldName) && isEmptyQuantityValue(event.target.value)
              ? 0
              : event.target.value;
          if (editableQuantityFields.has(fieldName) && isEmptyQuantityValue(event.target.value)) {
            event.target.value = '0';
          }
          if (String(currentDetail[fieldName] ?? '') === String(nextValue ?? '')) {
            return;
          }

          await StorageService.updateDetail(siteId, itemId, row.dataset.detailId, {
            [fieldName]: nextValue,
          });
          if (fieldName === 'statut') {
            const statusField = event.target.closest('.detail-status-field');
            const row = event.target.closest('tr');
            if (statusField) {
              statusField.classList.toggle('detail-status-field--ok', nextValue === 'OK');
              statusField.classList.toggle('detail-status-field--ko', nextValue === 'K.O');
            }
            if (row) {
              row.classList.toggle('detail-row--ko', nextValue === 'K.O');
              setRowKoInteractionState(row, nextValue === 'K.O');
              applyDetailRowSemanticState(row);
            }
          }
          if (fieldName === 'qtePosee' || fieldName === 'qteSortie' || fieldName === 'qteRebus' || fieldName === 'qteRetour') {
            const ecartField = row.querySelector('[data-col-key="ecart"]');
            if (ecartField) {
              const nextEcart = computeEcart({
                ...currentDetail,
                [fieldName]: nextValue,
              });
              updateEcartFieldDisplay(ecartField, nextEcart);
              ecartField.classList.toggle('cell-input--ecart-alert', typeof nextEcart === 'number' && !quantitiesAreEqual(nextEcart, 0));
            }
            applyDetailRowSemanticState(row);
          }
          applyCompactColumnWidths();
        });

        if (field.classList.contains('cell-input--compact-dynamic')) {
          field.addEventListener('input', () => {
            if (field.disabled) {
              return;
            }
            if (field.value.length > 120) {
              field.value = field.value.slice(0, 120);
            }
            if (field.dataset.field === 'qtePosee' || field.dataset.field === 'qteSortie' || field.dataset.field === 'qteRebus' || field.dataset.field === 'qteRetour' || field.dataset.field === 'statut') {
              const row = field.closest('tr');
              if (row) {
                if (field.dataset.field !== 'statut') {
                  const ecart = computeEcart({
                    qteSortie: row.querySelector('[data-field="qteSortie"]')?.value,
                    qtePosee: row.querySelector('[data-field="qtePosee"]')?.value,
                    qteRebus: row.querySelector('[data-field="qteRebus"]')?.value,
                    qteRetour: row.querySelector('[data-field="qteRetour"]')?.value,
                  });
                  const ecartField = row.querySelector('[data-col-key="ecart"]');
                  if (ecartField) {
                    updateEcartFieldDisplay(ecartField, ecart);
                    ecartField.classList.toggle('cell-input--ecart-alert', !quantitiesAreEqual(ecart, 0));
                  }
                }
                applyDetailRowSemanticState(row);
              }
            }
            applyCompactColumnWidths();
          });
        }

        if (field.classList.contains('cell-input--designation')) {
          field.addEventListener('input', () => {
            if (field.value.length > 120) {
              field.value = field.value.slice(0, 120);
            }
            adjustDesignationFieldHeight(field);
          });
          adjustDesignationFieldHeight(field);
        }
      });

      detailTableBody.querySelectorAll('[data-detail-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          await askDetailDeleteConfirmation(button.dataset.detailDelete);
        });
      });

      applyCompactColumnWidths();
    }

    function applyCompactColumnWidths() {
      const autoFields = detailTableBody.querySelectorAll('.cell-input--compact-dynamic[data-col-key]');
      if (!autoFields.length) {
        return;
      }

      const columns = new Map();
      autoFields.forEach((input) => {
        const key = input.dataset.colKey;
        if (!columns.has(key)) {
          columns.set(key, []);
        }
        columns.get(key).push(input);
      });

      const measurer = document.createElement('span');
      measurer.className = 'cell-input-measurer';
      document.body.appendChild(measurer);

      const minWidthByColumn = {
        qteSortie: 48,
        qtePosee: 48,
        qteRebus: 0,
        qteRetour: 48,
        dateRetour: 140,
        ecart: 48,
        observation: 48,
        code: 48,
        statut: 84,
      };

      columns.forEach((inputs, key) => {
        if (key === 'dateRetour') {
          inputs.forEach((input) => {
            input.style.width = '';
          });
          return;
        }

        let maxWidth = minWidthByColumn[key] || 48;

        inputs.forEach((input) => {
          const computed = window.getComputedStyle(input);
          measurer.style.font = computed.font;
          measurer.style.letterSpacing = computed.letterSpacing;
          measurer.textContent = String(input.value ?? '');
          const contentWidth = Math.ceil(measurer.getBoundingClientRect().width);
          const horizontalPadding = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight);
          const horizontalBorder = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
          const minWidth = Math.max(parseFloat(computed.minWidth) || 0, minWidthByColumn[key] || 48);
          const width = Math.max(minWidth, contentWidth + horizontalPadding + horizontalBorder + 10);
          maxWidth = Math.max(maxWidth, width);
        });

        inputs.forEach((input) => {
          input.style.width = `${Math.ceil(maxWidth)}px`;
        });
      });

      measurer.remove();
    }

    function adjustDesignationFieldHeight(field) {
      if (!field || !field.classList?.contains('cell-input--designation')) {
        return;
      }

      field.style.height = 'auto';
      const minHeight = parseFloat(window.getComputedStyle(field).minHeight) || 0;
      const nextHeight = Math.max(minHeight, field.scrollHeight);
      field.style.height = `${Math.ceil(nextHeight)}px`;
    }

    detailForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearDetailFormError();
      let hasFieldError = false;
      if (!String(codeInput.value || '').trim()) {
        showDetailFieldError('code', 'Veuillez remplir ce champ');
        hasFieldError = true;
      }
      if (!String(designationInput.value || '').trim()) {
        showDetailFieldError('designation', 'Veuillez remplir ce champ');
        hasFieldError = true;
      }
      if (hasFieldError) {
        return;
      }
      if (!permissions.canCreate) {
        showDetailFormError('Action non autorisée.');
        return;
      }

      setDetailFormSavingState(true);
      try {
        const result = await StorageService.createDetail(siteId, itemId, {
          code: requireElement('codeInput').value,
          designation: designationInput.value,
          qteSortie: requireElement('qteSortieInput').value,
          unite: requireElement('uniteInput').value,
          statut: requireElement('statutInput')?.value || 'OK',
        });
        if (!result?.ok) {
          showDetailFormError(
            result?.reason === 'duplicate_designation'
              ? 'Cette désignation existe déjà pour ce N° OUT.'
              : 'Création impossible. Vérifiez la désignation.',
          );
          return;
        }
        detailForm.reset();
        requireElement('uniteInput').value = getAutomaticUnit('');
        requireElement('statutInput').value = 'OK';
        updateDetailInputCounters();
        hideCodeSuggestions();
        clearDetailFormError();
        closeDetailModal();
        UiService.showToast('Article ajoutée .');
      } finally {
        setDetailFormSavingState(false);
      }
    });

    if (openDetailFormButton) {
      openDetailFormButton.addEventListener('click', openDetailModal);
    }

    if (cancelDetailFormButton) {
      cancelDetailFormButton.addEventListener('click', closeDetailModal);
    }

    if (detailFormModal) {
      detailFormModal.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDetailModal();
      });

      detailFormModal.addEventListener('click', (event) => {
        if (event.target === detailFormModal) {
          closeDetailModal();
        }
      });

      detailFormModal.addEventListener('close', () => {
        setDetailModalOpenState(false);
      });
    }

    if (codeInput && codeSuggestions) {
      codeInput.addEventListener('focus', () => {
        if (!String(codeInput.value || '').trim()) {
          hideCodeSuggestions();
          return;
        }
        renderCodeSuggestions(codeInput.value);
      });

      codeInput.addEventListener('input', () => {
        clearDetailFormError();
        clearDetailFieldErrorState('code');
        updateInputCharCounter(codeInput, codeInputCounter);
        renderCodeSuggestions(codeInput.value);
      });

      codeInput.addEventListener('beforeinput', (event) => {
        enforceMaxLengthOnBeforeInput(event, codeInput);
      });

      codeInput.addEventListener('paste', (event) => {
        enforceMaxLengthOnPaste(event, codeInput, codeInputCounter);
        renderCodeSuggestions(codeInput.value);
      });

      codeInput.addEventListener('keydown', (event) => {
        if (!visibleCodeSuggestions.length) {
          return;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const nextIndex = activeSuggestionIndex < visibleCodeSuggestions.length - 1 ? activeSuggestionIndex + 1 : 0;
          setActiveSuggestion(nextIndex);
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const nextIndex = activeSuggestionIndex > 0 ? activeSuggestionIndex - 1 : visibleCodeSuggestions.length - 1;
          setActiveSuggestion(nextIndex);
          return;
        }

        if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
          event.preventDefault();
          applyCodeSuggestion(visibleCodeSuggestions[activeSuggestionIndex]);
          return;
        }

        if (event.key === 'Escape') {
          hideCodeSuggestions();
        }
      });

      codeInput.addEventListener('blur', () => {
        window.setTimeout(hideCodeSuggestions, 140);
      });

      codeSuggestions.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });

      codeSuggestions.addEventListener('click', (event) => {
        const option = event.target.closest('[data-typeahead-index]');
        if (!option) {
          return;
        }
        const suggestion = visibleCodeSuggestions[Number(option.dataset.typeaheadIndex)];
        applyCodeSuggestion(suggestion);
      });
    }

    if (designationInput) {
      designationInput.addEventListener('input', () => {
        clearDetailFormError();
        clearDetailFieldErrorState('designation');
        updateInputCharCounter(designationInput, designationInputCounter);
        requireElement('uniteInput').value = getAutomaticUnit(designationInput.value);
      });
      designationInput.addEventListener('beforeinput', (event) => {
        enforceMaxLengthOnBeforeInput(event, designationInput);
      });
      designationInput.addEventListener('paste', (event) => {
        enforceMaxLengthOnPaste(event, designationInput, designationInputCounter);
      });
    }

    requireElement('qteSortieInput')?.addEventListener('input', clearDetailFormError);
    requireElement('uniteInput')?.addEventListener('change', clearDetailFormError);

    if (detailSearchInput) {
      detailSearchInput.addEventListener('input', () => {
        renderTable();
      });
      detailSearchInput.addEventListener('blur', () => {
        detailHistoryLogger.recordSearchOnBlur(detailSearchInput.value);
      });
      const toggleClearButton = () => {
        if (!detailSearchInput || !clearSearchBtn) {
          return;
        }
        clearSearchBtn.style.display = detailSearchInput.value.trim() ? 'flex' : 'none';
      };
      detailSearchInput.addEventListener('input', toggleClearButton);
      clearSearchBtn?.addEventListener('click', () => {
        if (!detailSearchInput) {
          return;
        }
        detailSearchInput.value = '';
        toggleClearButton();
        renderTable();
        detailSearchInput.focus();
      });
      detailSearchInput.value = page2SearchValue;
      toggleClearButton();
    }

    if (detailFilterButton && detailFilterMenu && detailFilterOptions.length) {
      syncDetailFilterUi();
      detailFilterButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (detailFilterMenu.hidden) {
          openDetailFilterMenu();
          return;
        }
        closeDetailFilterMenu();
      });

      detailFilterMenu.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      detailFilterOptions.forEach((option) => {
        option.addEventListener('click', () => {
          setDetailFilter(option.dataset.detailFilter || 'all');
          closeDetailFilterMenu();
        });
      });

      document.addEventListener('click', (event) => {
        if (!detailFilterMenu.hidden && !event.target.closest('.page3-filter-menu-wrap')) {
          closeDetailFilterMenu();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !detailFilterMenu.hidden) {
          closeDetailFilterMenu();
        }
      });
    }

    updateDetailExportButtonState(firebaseAuth.currentUser);

    if (exportButton) {
      exportButton.addEventListener('click', openDetailExportDialog);
    }

    if (detailExportCancelButton) {
      detailExportCancelButton.addEventListener('click', closeDetailExportDialog);
    }

    if (detailExportDialog) {
      detailExportDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDetailExportDialog();
      });
      detailExportDialog.addEventListener('click', (event) => {
        if (event.target === detailExportDialog) {
          closeDetailExportDialog();
        }
      });
    }

    if (detailExportFileNameInput) {
      detailExportFileNameInput.addEventListener('input', () => {
        updateDetailExportSubmitState();
      });
    }

    if (detailExportForm) {
      detailExportForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!isDetailExportAllowed()) {
          updateDetailExportButtonState();
          return;
        }
        if (!detailExportSubmitButton || detailExportSubmitButton.disabled) {
          return;
        }
        const fileName = sanitizeExportFileName(detailExportFileNameInput?.value || '');
        if (!fileName) {
          updateDetailExportSubmitState();
          return;
        }
        detailExportSubmitButton.disabled = true;
        detailExportSubmitButton.classList.add('is-loading');
        try {
          exportDetails(fileName);
          closeDetailExportDialog();
        } catch (_error) {
          detailExportSubmitButton.disabled = false;
          detailExportSubmitButton.classList.remove('is-loading');
          UiService.showToast('Exportation impossible.');
        }
      });
    }

    function showDetailTableSkeleton() {
      if (hasResolvedInitialDetails || isDetailSkeletonVisible) {
        return;
      }
      isDetailSkeletonVisible = true;
      detailTableBody.innerHTML = Array.from({ length: 4 }, (_, rowIndex) => `
        <tr class="detail-skeleton-row" aria-hidden="true">
          ${Array.from({ length: 11 }, (_, columnIndex) => {
    const shouldUseShortBlock = (rowIndex + columnIndex) % 3 === 0;
    return `<td><span class="detail-skeleton-block${shouldUseShortBlock ? ' detail-skeleton-block--short' : ''}"></span></td>`;
  }).join('')}
        </tr>
      `).join('');
    }

    function hideDetailTableSkeleton() {
      if (!isDetailSkeletonVisible) {
        return;
      }
      isDetailSkeletonVisible = false;
      detailTableBody.innerHTML = '';
    }

    updateCount(null, null);

    detailSkeletonTimerId = window.setTimeout(() => {
      showDetailTableSkeleton();
    }, 120);

    StorageService.subscribeSites((sites) => {
      currentSite = sites.find((site) => site.id === siteId) || currentSite;
      renderTitle();
      refreshCodeSuggestionSource();
    });

    StorageService.subscribeItems(siteId, (items) => {
      currentItem = items.find((item) => item.id === itemId) || currentItem;
      if (!currentItem) {
        UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
        return;
      }
      renderTitle();
      renderStoreLabel();
    });

    StorageService.subscribeDetails(
      siteId,
      itemId,
      (details) => {
        hasResolvedInitialDetails = true;
        if (detailSkeletonTimerId !== null) {
          window.clearTimeout(detailSkeletonTimerId);
          detailSkeletonTimerId = null;
        }
        animateNextTableRender = isDetailSkeletonVisible;
        hideDetailTableSkeleton();
        currentDetails = details;
        renderTable();
      },
      () => {
        UiService.showToast('Synchronisation  indisponible.');
      },
    );

    renderTitle();
    renderStoreLabel();
    updateDetailInputCounters();
    refreshCodeSuggestionSource();
  }



  async function initUsersPage(permissions) {
    if (!permissions.isAdmin && !permissions.isStandard) {
      UiService.navigate('index.html');
      return;
    }

    const tableBody = requireElement('usersTableBody');
    const usersSearchInput = document.getElementById('usersSearchInput');
    const backButton = requireElement('usersBackButton');
    const maintenanceToggle = requireElement('maintenanceToggle');
    const maintenanceStatusText = requireElement('maintenanceStatusText');
    backButton?.addEventListener('click', () => UiService.navigate('index.html'));

    const roleLabel = { standard: 'Adjoint Admin', limite: 'Limité' };

    function cleanText(value) {
      return String(value || '').trim();
    }

    function normalizeSearchText(value) {
      return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    }

    function resolveDisplayName(user) {
      const displayName = cleanText(user?.username || user?.displayName || user?.name);
      if (displayName) {
        return displayName;
      }
      const emailPrefix = cleanText(user?.email).split('@')[0];
      return emailPrefix || 'Utilisateur';
    }

    function resolveRole(user) {
      const role = cleanText(user?.role).toLowerCase();
      return role === 'standard' || role === 'adjoint' || role === 'adjoint admin' || role === 'admin' ? 'standard' : 'limite';
    }

    function splitFullName(value) {
      return cleanText(value).replace(/\s+/g, ' ').split(' ').filter(Boolean);
    }

    function resolveFirstName(user) {
      const explicitFirstName = cleanText(user?.firstName || user?.prenom || user?.['prénom']);
      if (explicitFirstName) {
        return explicitFirstName;
      }
      const nameParts = splitFullName(resolveDisplayName(user));
      return nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts[0] || '';
    }

    function resolveLastName(user) {
      const explicitLastName = cleanText(user?.lastName || user?.nom);
      if (explicitLastName) {
        return explicitLastName;
      }
      const nameParts = splitFullName(resolveDisplayName(user));
      return nameParts.length > 1 ? nameParts[nameParts.length - 1] : resolveDisplayName(user);
    }

    function userMatchesSearch(user, query) {
      if (!query) {
        return true;
      }
      return [
        resolveLastName(user),
        resolveFirstName(user),
        resolveDisplayName(user),
        user?.email,
      ].some((value) => normalizeSearchText(value).includes(query));
    }

    function resolveMaintenanceAuthorized(user) {
      if (typeof user?.maintenanceAuthorized === 'boolean') {
        return user.maintenanceAuthorized;
      }
      if (typeof user?.maintenanceAccess === 'boolean') {
        return user.maintenanceAccess;
      }
      return false;
    }

    function updateMaintenanceLabel(isEnabled) {
      if (maintenanceStatusText) {
        maintenanceStatusText.textContent = isEnabled ? 'Activé' : 'Désactivé';
      }
      if (maintenanceToggle) {
        maintenanceToggle.checked = Boolean(isEnabled);
      }
    }

    function parseActivityDate(value) {
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

    function isUserOnline(user, referenceDate = new Date()) {
      if (user?.online === true || cleanText(user?.presence).toLowerCase() === 'online' || cleanText(user?.status).toLowerCase() === 'online') {
        return true;
      }
      const lastSeenDate = parseActivityDate(user?.lastSeen || user?.lastActivity);
      if (!lastSeenDate) {
        return false;
      }
      return Math.max(0, referenceDate.getTime() - lastSeenDate.getTime()) < 5 * 60000;
    }

    function updateUsersCardHeader(users) {
      const usersCardHeader = document.getElementById('usersCardHeader');
      if (!usersCardHeader) {
        return;
      }
      const referenceDate = new Date();
      const onlineCount = users.filter((user) => isUserOnline(user, referenceDate)).length;
      usersCardHeader.innerHTML = `<span class="users-card-online-label">En ligne</span> : <span class="users-card-stat users-card-stat--online">${onlineCount}</span><br />Tous les utilisateurs : <span class="users-card-stat users-card-stat--total">${users.length}</span>`;
    }

    function formatLastActivity(value, referenceDate = new Date()) {
      const activityDate = parseActivityDate(value);
      if (!activityDate) {
        return '-';
      }
      const elapsedMs = Math.max(0, referenceDate.getTime() - activityDate.getTime());
      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      if (elapsedMinutes < 5) {
        return '🟢 En ligne';
      }
      if (elapsedMinutes < 60) {
        return `Il y a ${elapsedMinutes} min`;
      }
      const elapsedHours = Math.floor(elapsedMinutes / 60);
      if (elapsedHours < 24) {
        return `Il y a ${elapsedHours} h`;
      }
      const elapsedDays = Math.floor(elapsedHours / 24);
      if (elapsedDays < 7) {
        return `Il y a ${elapsedDays} jour${elapsedDays > 1 ? 's' : ''}`;
      }
      const elapsedWeeks = Math.floor(elapsedDays / 7);
      if (elapsedDays < 30) {
        return `Il y a ${elapsedWeeks} semaine${elapsedWeeks > 1 ? 's' : ''}`;
      }
      const elapsedMonths = Math.max(1, Math.floor(elapsedDays / 30));
      return `Il y a ${elapsedMonths} mois`;
    }

    function sortUsersByPointsAndName(users, pointsByUser) {
      return [...users].sort((a, b) => {
        const pointsA = Number(pointsByUser?.[a.id] || 0);
        const pointsB = Number(pointsByUser?.[b.id] || 0);
        if (pointsA !== pointsB) {
          return pointsB - pointsA;
        }
        return resolveDisplayName(a).localeCompare(resolveDisplayName(b), 'fr', { sensitivity: 'base' });
      });
    }

    function renderUsers(users, pointsByUser = {}) {
      const sortedUsers = sortUsersByPointsAndName(users, pointsByUser);
      if (!sortedUsers.length) {
        tableBody.innerHTML = '<tr><td colspan="8" class="users-empty-cell">Aucun utilisateur trouvé.</td></tr>';
        return;
      }

      tableBody.innerHTML = sortedUsers
        .map((user) => `
          <tr>
            <td class="users-point-cell">${Number(pointsByUser?.[user.id] || 0)}</td>
            <td>
              ${cleanText(user.avatarUrl)
      ? `<img class="table-avatar" src="${escapeHtml(user.avatarUrl)}" alt="Avatar de ${escapeHtml(resolveDisplayName(user))}" />`
      : `<span class="table-avatar table-avatar--fallback">${escapeHtml(getInitialsFromName(resolveDisplayName(user)).slice(0, 2))}</span>`}
            </td>
            <td>${escapeHtml(resolveDisplayName(user))}</td>
            <td class="users-last-activity-cell">${escapeHtml(formatLastActivity(user.lastActivity))}</td>
            <td class="users-email-cell" title="${escapeHtml(cleanText(user.email) || '-')}">${escapeHtml(cleanText(user.email) || '-')}</td>
            <td>
              ${cleanText(user.email).toLowerCase() === 'andrainaaina@gmail.com' ? 'admin' : `
              <select data-user-role="${user.id}">
                <option value="standard" ${resolveRole(user) === 'standard' ? 'selected' : ''}>${roleLabel.standard}</option>
                <option value="limite" ${resolveRole(user) === 'limite' ? 'selected' : ''}>${roleLabel.limite}</option>
              </select>`}
            </td>
            <td class="maintenance-access-cell">
              <input
                type="checkbox"
                class="maintenance-access-checkbox"
                data-user-maintenance-access="${user.id}"
                ${resolveMaintenanceAuthorized(user) ? 'checked' : ''}
                aria-label="Autoriser ${escapeHtml(resolveDisplayName(user))} pendant la maintenance"
              />
            </td>
            <td>
              ${cleanText(user.email).toLowerCase() === 'andrainaaina@gmail.com'
      ? '<span class="table-action-disabled">-</span>'
      : `<button type="button" class="table-delete-icon-button" data-delete-user="${user.id}" aria-label="Supprimer" title="Supprimer"><img src="Icon/poubelle.png" alt="" aria-hidden="true" class="table-delete-icon-button__icon" /></button>`}
            </td>
          </tr>
        `)
        .join('');

      tableBody.querySelectorAll('[data-user-role]').forEach((select) => {
        select.addEventListener('change', async () => {
          await StorageService.updateUserRole(select.dataset.userRole, select.value);
          UiService.showToast('Rôle mis à jour.');
        });
      });

      tableBody.querySelectorAll('[data-user-maintenance-access]').forEach((checkbox) => {
        checkbox.addEventListener('change', async () => {
          const isAllowed = checkbox.checked;
          try {
            await StorageService.updateUserMaintenanceAccess(checkbox.dataset.userMaintenanceAccess, isAllowed);
            UiService.showToast('Accès maintenance mis à jour.');
          } catch (_error) {
            checkbox.checked = !isAllowed;
            UiService.showToast('Impossible de mettre à jour l’accès maintenance.');
          }
        });
      });

      tableBody.querySelectorAll('[data-delete-user]').forEach((button) => {
        button.addEventListener('click', async () => {
          const shouldDelete = window.confirm('Êtes-vous sûr de vouloir supprimer cet utilisateur ?');
          if (!shouldDelete) {
            return;
          }
          await StorageService.deleteUser(button.dataset.deleteUser);
          UiService.showToast('Utilisateur supprimé.');
        });
      });
    }

    let ignoreToggleEvent = false;
    StorageService.subscribeMaintenanceState(
      (maintenanceState) => {
        ignoreToggleEvent = true;
        updateMaintenanceLabel(Boolean(maintenanceState.enabled));
        ignoreToggleEvent = false;
      },
      () => {
        UiService.showToast('Impossible de synchroniser l’état de maintenance.');
      },
    );

    maintenanceToggle?.addEventListener('change', async () => {
      if (ignoreToggleEvent) {
        return;
      }
      const enabled = maintenanceToggle.checked;
      updateMaintenanceLabel(enabled);
      try {
        await StorageService.setMaintenanceState(enabled);
      } catch (_error) {
        updateMaintenanceLabel(!enabled);
        UiService.showToast('Échec de mise à jour de l’état de maintenance.');
      }
    });

    let currentUsers = [];
    let currentPointsByUser = {};
    let currentUsersSearchQuery = '';
    let lastActivityRefreshId = null;

    function renderCurrentUsers() {
      updateUsersCardHeader(currentUsers);
      const filteredUsers = currentUsers.filter((user) => userMatchesSearch(user, currentUsersSearchQuery));
      renderUsers(filteredUsers, currentPointsByUser);
    }

    usersSearchInput?.addEventListener('input', () => {
      currentUsersSearchQuery = normalizeSearchText(usersSearchInput.value);
      renderCurrentUsers();
    });

    lastActivityRefreshId = window.setInterval(renderCurrentUsers, 60000);
    window.addEventListener('pagehide', () => {
      if (lastActivityRefreshId) {
        window.clearInterval(lastActivityRefreshId);
      }
    });

    try {
      const cleanupResult = await StorageService.cleanupInactiveUsers?.();
      if (cleanupResult?.deletedCount) {
        UiService.showToast(`${cleanupResult.deletedCount} utilisateur(s) inactif(s) supprimé(s).`);
      }

      const [initialUsers, initialPointsByUser] = await Promise.all([
        StorageService.listUsers(),
        StorageService.listOutCreationPoints(),
      ]);
      currentUsers = initialUsers;
      currentPointsByUser = initialPointsByUser;
      renderCurrentUsers();
    } catch (_error) {
      UiService.showToast('Impossible de charger les utilisateurs.');
    }

    StorageService.subscribeUsers(
      (users) => {
        console.log('[users] documents récupérés :', users.length);
        users.forEach((user) => {
          console.log('[users] doc:', user.id, {
            displayName: resolveDisplayName(user),
            email: cleanText(user.email),
            role: resolveRole(user),
            maintenanceAuthorized: resolveMaintenanceAuthorized(user),
          });
        });
        currentUsers = users;
        renderCurrentUsers();
      },
      () => {
        UiService.showToast('Synchronisation des utilisateurs indisponible.');
      },
    );

    StorageService.subscribeOutCreationPoints(
      (pointsByUser) => {
        currentPointsByUser = pointsByUser;
        renderCurrentUsers();
      },
      () => {
        UiService.showToast('Synchronisation des points indisponible.');
      },
    );
  }

  function formatHistoryActionWithSite(history) {
    const action = String(history?.action || '').trim();
    const siteName = String(history?.siteName || '').trim();
    if (!action || !siteName) {
      return action;
    }
    if (/\bsite\s+«[^»]+»/i.test(action) || /\bdans le site\s+«[^»]+»[.!?]?$/i.test(action) || /\bdu site\s+«[^»]+»[.!?]?$/i.test(action)) {
      return action;
    }
    const suffix = `site « ${siteName} »`;
    if (/^a (?:recherché|appliqué le filtre)\b/i.test(action)) {
      return `${action} dans le site « ${siteName} ».`;
    }
    if (/^a déverrouillé le site\b/i.test(action)) {
      return `${action} « ${siteName} ».`;
    }
    if (/^a créé le site\b/i.test(action) || /^a supprimé le site\b/i.test(action) || /\ble site\b/i.test(action)) {
      return `${action} dans le ${suffix}.`;
    }
    return `${action} du ${suffix}.`;
  }

  async function initHistoryPage() {
    const historyList = requireElement('historyList');
    if (!historyList) {
      return;
    }

    const renderHistoriques = (historiques, users = []) => {
      if (!historiques.length) {
        UiService.renderEmptyState(historyList, 'Aucun historique enregistré pour le moment.');
        return;
      }
      const usersById = users.reduce((accumulator, user) => {
        if (user?.id) {
          accumulator[user.id] = user;
        }
        return accumulator;
      }, {});
      const usersByName = users.reduce((accumulator, user) => {
        const usernameKey = String(user?.username || '').trim().toLowerCase();
        if (usernameKey && !accumulator[usernameKey]) {
          accumulator[usernameKey] = user;
        }
        return accumulator;
      }, {});

      historyList.innerHTML = `
        <ul class="history-list__items">
          ${historiques
            .map((history) => {
              const normalizedName = String(history.userName || '').trim().toLowerCase();
              const matchedUser = usersById[history.userId] || usersByName[normalizedName] || null;
              const avatarUrl = String(matchedUser?.avatarUrl || '').trim();
              const displayName = String(history.userName || 'Utilisateur inconnu').trim();
              const initials = getInitialsFromName(displayName);
              const avatarMarkup = avatarUrl
                ? `<img class="history-list__avatar-image" src="${escapeHtml(avatarUrl)}" alt="Avatar de ${escapeHtml(displayName)}" />`
                : `<span class="history-list__avatar-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
              return `
              <li class="history-list__item" aria-label="Historique">
                <div class="history-list__avatar">
                  ${avatarMarkup}
                </div>
                <div class="history-list__content">
                  <p class="history-list__name">${escapeHtml(displayName)}</p>
                  <p class="history-list__title">${escapeHtml(formatHistoryActionWithSite(history))}</p>
                  <p class="history-list__date">${escapeHtml(UiService.formatDate(history.createdAt?.toDate?.() || history.createdAt))}</p>
                </div>
              </li>
            `;
            })
            .join('')}
        </ul>
      `;
    };

    try {
      const users = await StorageService.listUsers();
      const initialHistoriques = await StorageService.listHistoriques();
      renderHistoriques(initialHistoriques, users);
      if (typeof StorageService.subscribeHistoriques === 'function') {
        StorageService.subscribeHistoriques(
          (historiques) => renderHistoriques(historiques, users),
          () => {
            UiService.renderEmptyState(historyList, "Impossible de charger l'historique.");
          },
        );
      }
    } catch (_error) {
      UiService.renderEmptyState(historyList, "Impossible de charger l'historique.");
    }
  }
  function resolveConnectedProfile(profile, isAuthenticated) {
    const nextProfile = { ...(profile || {}) };
    const email = String(nextProfile?.email || '').trim().toLowerCase();

    if (!isAuthenticated) {
      return { role: 'lecture' };
    }

    if (email === 'andrainaaina@gmail.com') {
      nextProfile.role = 'admin';
      return nextProfile;
    }

    if (!String(nextProfile.role || '').trim()) {
      nextProfile.role = 'limite';
    }
    return nextProfile;
  }


  function initPurchaseDetailPage(permissions) {
    initAuthRequiredNoticeCard();

    const params = UiService.getQueryParams();
    const siteId = params.get('siteId');
    const purchaseId = params.get('purchaseId');
    if (!siteId || !purchaseId) {
      UiService.navigate('index.html');
      return;
    }

    const backButton = requireElement('purchaseDetailBackButton');
    const summary = requireElement('purchaseDetailSummary');
    const summaryName = requireElement('purchaseDetailName');
    const summaryCreatedAt = requireElement('purchaseDetailCreatedAt');
    const summaryMedia = summary?.querySelector('.purchase-detail-summary__media');
    const imageButton = requireElement('purchaseDetailImageButton');
    const image = requireElement('purchaseDetailImage');
    const imagePlaceholder = requireElement('purchaseDetailImagePlaceholder');
    const imageEditButton = requireElement('purchaseDetailImageEditButton');
    const imageInput = requireElement('purchaseDetailImageInput');
    const qty = requireElement('purchaseDetailQty');
    const store = requireElement('purchaseDetailStore');
    const remarkRow = requireElement('purchaseDetailRemarkRow');
    const remark = requireElement('purchaseDetailRemark');
    const user = requireElement('purchaseDetailUser');
    const fullDate = requireElement('purchaseDetailFullDate');
    const imageDialog = requireElement('purchaseImageDialog');
    const imageDialogImage = requireElement('purchaseImageDialogImage');
    const imageDialogClose = requireElement('purchaseImageDialogClose');
    const saveSpinner = requireElement('purchaseDetailSaveSpinner');
    let canEditPurchase = Boolean(permissions?.isAdmin);
    let currentPurchase = null;

    function getCurrentPurchaseActor() {
      return {
        id: String(permissions?.userId || firebaseAuth.currentUser?.uid || '').trim(),
        name: String(
          permissions?.username
          || firebaseAuth.currentUser?.displayName
          || firebaseAuth.currentUser?.email
          || 'Utilisateur',
        ).trim() || 'Utilisateur',
      };
    }

    function canCurrentUserEditPurchase(purchase) {
      if (permissions?.isAdmin) {
        return true;
      }
      const actor = getCurrentPurchaseActor();
      const creatorId = String(purchase?.createdBy || '').trim();
      return Boolean(actor.id && creatorId && actor.id === creatorId);
    }

    function addPurchaseUpdateMetadata(updates) {
      const actor = getCurrentPurchaseActor();
      return {
        ...updates,
        updatedAt: serverTimestamp(),
        updatedBy: actor.id || null,
        updatedByName: actor.name,
      };
    }
    let isSavingPurchase = false;

    function setPurchaseSaving(isSaving) {
      isSavingPurchase = isSaving;
      saveSpinner?.classList.toggle('is-visible', isSaving);
    }

    function normalizePurchaseQtyInput(value) {
      const parsed = Number.parseInt(String(value || '').replace(',', '.').match(/\d+/)?.[0] || '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return null;
      }
      return Math.min(parsed, 9999);
    }

    function resizeInlineTextarea(field) {
      if (!field || field.tagName !== 'TEXTAREA') return;
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    }

    function setEditableState(field) {
      if (!field) return;
      field.readOnly = !canEditPurchase;
      field.toggleAttribute('aria-readonly', !canEditPurchase);
      field.tabIndex = canEditPurchase ? 0 : -1;
    }

    async function savePurchaseImageFile(file) {
      if (!canEditPurchase || !currentPurchase || isSavingPurchase || !file) return;
      const previousPurchase = { ...currentPurchase };
      setPurchaseSaving(true);
      try {
        const uploadedImage = await uploadPurchaseImageToCloudinary(file);
        if (!uploadedImage?.imageUrl) {
          throw new Error('Upload Cloudinary échoué');
        }
        const updates = addPurchaseUpdateMetadata({
          imageUrl: uploadedImage.imageUrl,
          imagePublicId: uploadedImage.publicId,
        });
        await updateDoc(doc(firebaseDb, 'sites', siteId, 'achatsMateriels', purchaseId), updates);
        currentPurchase = { ...currentPurchase, ...updates };
        renderPurchaseDetail(currentPurchase);
      } catch (error) {
        console.error('Erreur mise à jour image achat matériel :', error);
        currentPurchase = previousPurchase;
        renderPurchaseDetail(previousPurchase);
        UiService.showToast?.('Erreur lors de l’enregistrement de l’achat matériel.');
      } finally {
        if (imageInput) {
          imageInput.value = '';
        }
        setPurchaseSaving(false);
      }
    }

    async function saveInlinePurchaseField(fieldName, input) {
      if (!canEditPurchase || !currentPurchase || isSavingPurchase || !input) return;
      const previousPurchase = { ...currentPurchase };
      const previousInputValue = input.value;
      let updates = null;

      if (fieldName === 'designation') {
        const designation = String(input.value || '').trim();
        if (!designation) {
          input.value = String(previousPurchase.designation || 'Achat matériel');
          return;
        }
        if (designation === String(previousPurchase.designation || '').trim()) return;
        updates = { designation };
      }

      if (fieldName === 'qty') {
        const qtyValue = normalizePurchaseQtyInput(input.value);
        if (!qtyValue) {
          input.value = `${Number(previousPurchase.qty || 0)} ${String(previousPurchase.unit || 'Pcs')}`;
          return;
        }
        if (qtyValue === Number(previousPurchase.qty || 0)) {
          input.value = `${qtyValue} ${String(previousPurchase.unit || 'Pcs')}`;
          return;
        }
        updates = { qty: qtyValue };
      }

      if (fieldName === 'magasin') {
        const magasin = String(input.value || '').trim();
        const oldStore = String(previousPurchase.store || previousPurchase.magasin || '').trim();
        if (magasin === oldStore) return;
        updates = { magasin, store: magasin };
      }

      if (fieldName === 'remarque') {
        const remarque = String(input.value || '').trim();
        if (remarque === String(previousPurchase.remarque || previousPurchase.remark || '').trim()) return;
        updates = { remarque, remark: remarque };
      }

      if (!updates) return;
      setPurchaseSaving(true);
      try {
        updates = addPurchaseUpdateMetadata(updates);
        await updateDoc(doc(firebaseDb, 'sites', siteId, 'achatsMateriels', purchaseId), updates);
        currentPurchase = { ...currentPurchase, ...updates };
        renderPurchaseDetail(currentPurchase);
        resizeInlineTextarea(input);
      } catch (error) {
        console.error('Erreur mise à jour achat matériel :', error);
        currentPurchase = previousPurchase;
        input.value = previousInputValue;
        renderPurchaseDetail(previousPurchase);
        resizeInlineTextarea(input);
        UiService.showToast?.('Erreur lors de l’enregistrement de l’achat matériel.');
      } finally {
        setPurchaseSaving(false);
      }
    }

    function bindInlinePurchaseField(input, fieldName) {
      setEditableState(input);
      resizeInlineTextarea(input);
      input?.addEventListener('input', () => resizeInlineTextarea(input));
      input?.addEventListener('blur', () => saveInlinePurchaseField(fieldName, input));
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && input.tagName !== 'TEXTAREA') {
          event.preventDefault();
          input.blur();
        }
      });
    }

    backButton?.addEventListener('click', () => {
      UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
    });

    function formatPurchaseDateLabel(purchase) {
      return buildDateAndTimeLabel(purchase?.createdAt || purchase?.dateAchat || purchase?.date || purchase?.dateCreation || purchase?.dateModification);
    }

    function renderPurchaseDetail(purchase) {
      const imageUrl = String(purchase?.imageUrl || '').trim();
      const dateLabel = formatPurchaseDateLabel(purchase);
      const purchaseStore = String(purchase?.store || purchase?.magasin || '').trim() || '-';
      const purchaseRemark = String(purchase?.remarque || purchase?.remark || '').trim();

      canEditPurchase = canCurrentUserEditPurchase(purchase);
      currentPurchase = purchase;
      summaryName.value = String(purchase?.designation || 'Achat matériel');
      summaryCreatedAt.textContent = dateLabel;
      summaryMedia.innerHTML = imageUrl
        ? `<img src="${escapeHtml(imageUrl)}" alt="Photo achat matériel" />`
        : `<img src="${escapeHtml(DEFAULT_PURCHASE_IMAGE_SRC)}" alt="" aria-hidden="true" />`;
      qty.value = `${Number(purchase?.qty || 0)} ${String(purchase?.unit || 'Pcs')}`;
      store.value = purchaseStore;
      if (purchaseRemark) {
        remark.value = purchaseRemark;
        remarkRow.hidden = false;
      } else {
        remark.value = '';
        remarkRow.hidden = !canEditPurchase;
      }
      user.textContent = String(purchase?.createdByName || purchase?.createdBy || 'Utilisateur');
      fullDate.textContent = dateLabel;
      [summaryName, qty, store, remark].forEach(setEditableState);
      resizeInlineTextarea(remark);

      if (imageUrl) {
        image.src = imageUrl;
        imageButton.hidden = false;
        imagePlaceholder.hidden = true;
      } else {
        image.removeAttribute('src');
        imageButton.hidden = true;
        imagePlaceholder.hidden = false;
      }
      if (imageEditButton) {
        imageEditButton.hidden = !canEditPurchase;
      }
    }

    bindInlinePurchaseField(summaryName, 'designation');
    bindInlinePurchaseField(qty, 'qty');
    bindInlinePurchaseField(store, 'magasin');
    bindInlinePurchaseField(remark, 'remarque');

    imageButton?.addEventListener('click', () => {
      const imageUrl = String(image?.src || '').trim();
      if (!imageUrl || !imageDialog || !imageDialogImage) return;
      imageDialogImage.src = imageUrl;
      imageDialog.showModal();
    });
    imageEditButton?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!canEditPurchase || isSavingPurchase) return;
      imageInput?.click();
    });
    imageInput?.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      savePurchaseImageFile(file);
    });
    imageDialogClose?.addEventListener('click', () => imageDialog?.close());
    imageDialog?.addEventListener('click', (event) => {
      if (event.target === imageDialog) {
        imageDialog.close();
      }
    });

    getDoc(doc(firebaseDb, 'sites', siteId, 'achatsMateriels', purchaseId))
      .then((snapshot) => {
        if (!snapshot.exists()) {
          UiService.showToast?.('Achat matériel introuvable.');
          UiService.navigate(`page2.html?siteId=${encodeURIComponent(siteId)}`);
          return;
        }
        renderPurchaseDetail({ id: snapshot.id, ...snapshot.data() });
      })
      .catch((error) => {
        console.error('Erreur chargement détail achat matériel :', error);
        UiService.showToast?.('Erreur lors du chargement de l’achat matériel.');
      });
  }

  async function bootstrap() {
    UiService.bindDialogCloser();
    setupBackButtons();

    const authUser = await waitForAuthState();
    await StorageService.init();

    const isAuthenticated = Boolean(authUser);
    let profile = await StorageService.getCurrentUserProfile();

    if (isAuthenticated) {
      await StorageService.ensureCurrentUser();
      profile = await StorageService.getCurrentUserProfile();
    }

    profile = resolveConnectedProfile(profile, isAuthenticated);

    const permissions = buildPermissions(profile);
    window.AppPermissions = permissions;
    window.dispatchEvent(new CustomEvent('app:permissions-ready', { detail: { permissions } }));

    initMaintenanceGate(permissions, profile);

    const page = document.body.dataset.page;
    if (page === 'home') {
      initHomePage(permissions, { isAuthenticated, authUser });
    }
    if (page === 'site-detail') {
      initSiteDetailPage(permissions);
    }
    if (page === 'item-detail') {
      initItemDetailPage(permissions);
    }
    if (page === 'purchase-detail') {
      initPurchaseDetailPage(permissions);
    }
    if (page === 'users-management') {
      await initUsersPage(permissions);
    }
    if (page === 'history') {
      await initHistoryPage();
    }
  }


  bootstrap().finally(() => {
    UiService.markAppReady();
  });
})();
