import { addDoc, collection, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseDb } from './firebase-core.js';

(function () {
  const isMaterialsPage = location.pathname.includes('materiels.html');
  const CART_KEY = 'materialRequestCart';
  const HINT_KEY = 'materialsHintSeen';
  const MAX_CART_LINES = 20;
  let materialCart = [];
  let lastRequestMeta = null;
  let isRequestPngDownloading = false;
  let displayedMaterials = [];
  let hasRecordedMaterialsPageOpen = false;


  function waitForAppPermissionsReady() {
    if (window.AppPermissions) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      window.addEventListener('app:permissions-ready', () => resolve(), { once: true });
    });
  }

  async function recordMaterialsPageOpenHistoryOnce() {
    if (hasRecordedMaterialsPageOpen) {
      return;
    }

    hasRecordedMaterialsPageOpen = true;

    try {
      await waitForAppPermissionsReady();
      await window.StorageService?.recordMaterialsPageOpenHistory?.();
    } catch (_error) {
      // L'historique ne doit pas bloquer l'ouverture de la page.
    }
  }

  function getCartItemKey(item = {}) {
    return String(item.code || item.manualKey || '');
  }

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



  function formatRequestDateTime(date = new Date()) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} • ${hours}:${minutes}`;
  }

  function buildRequestMainTitle(requestTitle = '') {
    const cleaned = String(requestTitle || '').trim();
    return cleaned ? `Demande matériel — ${cleaned}` : 'Demande matériel';
  }

  async function createMaterialRequestRecord(requestTitle = '') {
    const cleanedTitle = String(requestTitle || '').trim();
    const items = materialCart.map((item) => ({
      code: String(item.code || ''),
      designation: String(item.designation || ''),
      qty: sanitizeQty(item.qty),
      unit: item.unit || 'Pcs',
    }));

    await addDoc(collection(firebaseDb, 'materialRequests'), {
      requestTitle: cleanedTitle,
      createdAt: serverTimestamp(),
      items,
    });

    return {
      requestTitle: cleanedTitle,
      createdAtLabel: formatRequestDateTime(new Date()),
    };
  }

  function normalizeMaterialRow(data) {
    const code = String(data?.code || data?.ref || data?.reference || data?.Code || '').trim();
    const designation = String(
      data?.designation || data?.Designation || data?.désignation || data?.['Désignation'] || data?.name || '',
    ).trim();
    return { code, designation };
  }

  function loadMaterialCart() {
    try {
      const savedCart = JSON.parse(localStorage.getItem(CART_KEY)) || [];
      materialCart = savedCart.map((item) => ({
        ...item,
        manualKey: item.manualKey || '',
        unit: item.unit || getDefaultMaterialUnit(item.designation || ''),
      }));
    } catch (_error) {
      materialCart = [];
    }
  }

  function saveMaterialCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(materialCart));
  }

  function getDefaultMaterialUnit(designation = '') {
    const text = designation.toLowerCase();

    if (
      text.includes('cable')
      || text.includes('câble')
      || text.includes('cuivre')
      || text.includes('fil')
      || text.includes('gaine')
    ) {
      return 'm';
    }

    return 'Pcs';
  }

  function initMaterialsHint() {
    const hint = document.querySelector('#materialsHint');
    const closeBtn = document.querySelector('#closeMaterialsHint');

    if (!hint) {
      return;
    }

    const alreadySeen = localStorage.getItem(HINT_KEY) === 'true';

    if (!alreadySeen) {
      hint.classList.remove('hidden');
    }

    closeBtn?.addEventListener('click', () => {
      localStorage.setItem(HINT_KEY, 'true');
      hint.classList.add('hidden');
    });
  }

  function markMaterialsHintSeen() {
    localStorage.setItem(HINT_KEY, 'true');
    document.querySelector('#materialsHint')?.classList.add('hidden');
  }

  function updateMaterialCartBadge() {
    const badge = document.querySelector('#materialCartBadge');

    if (!badge) {
      return;
    }

    const count = materialCart.length;
    badge.textContent = String(count);

    if (count > 0) {
      badge.classList.add('visible');
      return;
    }

    badge.classList.remove('visible');
  }


  function addMaterialToCart(material) {
    const existing = materialCart.find((item) => item.code === material.code);

    if (existing) {
      existing.qty = (Number(existing.qty) || 1) + 1;
    } else {
      if (materialCart.length >= MAX_CART_LINES) {
        window.UiService?.showToast?.('Limite de 20 matériels atteinte.');
        const cartFab = requireElement('materialCartFab');
        cartFab?.classList.remove('bounce');
        void cartFab?.offsetWidth;
        cartFab?.classList.add('bounce');
        return;
      }
      materialCart.push({
        code: material.code,
        designation: material.designation,
        qty: 1,
        unit: getDefaultMaterialUnit(material.designation),
      });
    }

    saveMaterialCart();
    updateMaterialCartBadge();
    renderMaterialCart();
    markMaterialsHintSeen();
    window.UiService?.showToast?.(`${materialCart.length} matériel${materialCart.length > 1 ? 's' : ''} dans le panier`);
  }

  function removeMaterialFromCart(code) {
    materialCart = materialCart.filter((item) => getCartItemKey(item) !== code);
    saveMaterialCart();
    updateMaterialCartBadge();
    renderMaterialCart();
  }

  function sanitizeQty(value) {
    let qty = parseInt(value, 10);

    if (!Number.isFinite(qty) || qty < 1) {
      qty = 1;
    }

    if (qty > 9999) {
      qty = 9999;
    }

    return qty;
  }

  function increaseQty(code) {
    const item = materialCart.find((cartItem) => getCartItemKey(cartItem) === code);
    if (!item) {
      return;
    }
    item.qty = sanitizeQty((Number(item.qty) || 1) + 1);
    saveMaterialCart();
    updateMaterialCartBadge();
    renderMaterialCart();
  }

  function decreaseQty(code) {
    const item = materialCart.find((cartItem) => getCartItemKey(cartItem) === code);
    if (!item) {
      return;
    }
    item.qty = sanitizeQty((Number(item.qty) || 1) - 1);
    saveMaterialCart();
    updateMaterialCartBadge();
    renderMaterialCart();
  }

  function updateQtyFromInput(code, value) {
    const item = materialCart.find((cartItem) => getCartItemKey(cartItem) === code);
    if (!item) {
      return;
    }

    item.qty = sanitizeQty(value);

    saveMaterialCart();
    updateMaterialCartBadge();
  }

  function updateMaterialUnit(code, newUnit) {
    materialCart = materialCart.map((item) => {
      if (getCartItemKey(item) === code) {
        return { ...item, unit: newUnit };
      }
      return item;
    });

    saveMaterialCart();
    renderMaterialCart();
  }


  function syncMaterialCartActionsState() {
    const isEmpty = materialCart.length === 0;
    const clearBtn = requireElement('clearMaterialCartBtn');
    const pngBtn = requireElement('downloadRequestPngBtn');

    [clearBtn, pngBtn].forEach((btn) => {
      if (!btn) {
        return;
      }
      btn.disabled = isEmpty;
      btn.classList.toggle('is-disabled-soft', isEmpty);
    });
  }

  function canExportMaterials() {
    return Boolean(window.AppPermissions?.canImportExport);
  }

  function syncMaterialsExportButtonVisibility() {
    const exportButton = requireElement('materialsExportBtn');
    if (!exportButton) {
      return;
    }
    const canExport = canExportMaterials();
    exportButton.hidden = !canExport;
    exportButton.classList.toggle('hidden', !canExport);
  }

  function buildMaterialsExportRows(materials) {
    return (Array.isArray(materials) ? materials : []).map((material) => ({
      code: material.code,
      designation: material.designation,
    }));
  }

  function exportDisplayedMaterials() {
    if (!canExportMaterials()) {
      window.UiService?.showToast?.('Action non autorisée.');
      return;
    }
    if (!displayedMaterials.length) {
      window.UiService?.showToast?.('Aucun matériel à exporter.');
      return;
    }
    const excelExport = window.AppExcelExport;
    if (!excelExport?.buildMaterialsExcelContent || !excelExport?.downloadExcelFile) {
      window.UiService?.showToast?.('Export Excel indisponible.');
      return;
    }
    const rows = buildMaterialsExportRows(displayedMaterials);
    const fileName = excelExport.buildPage2ExportFileName?.('demande-materiels', 'xlsx') || 'demande-materiels.xlsx';
    const workbook = excelExport.buildMaterialsExcelContent('Demande matériels', rows, 'Demande matériels');
    excelExport.downloadExcelFile(fileName, 'Export Excel', workbook);
    excelExport.saveExportFileNameToHistory?.(fileName);
  }

  function renderMaterialCart() {
    const list = document.querySelector('#materialCartList');
    if (!list) {
      return;
    }
    const countEl = document.querySelector('#cartSelectedCount');
    const count = materialCart.length;

    if (countEl) {
      countEl.textContent =
        count > 1
          ? `${count} matériels sélectionnés`
          : `${count} matériel sélectionné`;
    }

    if (!materialCart.length) {
      list.innerHTML = `
        <div class="empty-cart">
          <p>Aucun matériel dans la demande.</p>
          <p class="empty-cart-hint">💡 Ajoutez des matériels depuis la liste pour créer une demande</p>
        </div>
      `;
      syncMaterialCartActionsState();
      return;
    }

    list.innerHTML = materialCart
      .map((item) => `
      <div class="material-cart-card">
        <div class="material-cart-info">
          <strong>${escapeHtml(item.code)}</strong>
          <p>${escapeHtml(item.designation || '-')}</p>
          <div class="qty-control">
            <button class="btn btn-secondary qty-minus" data-code="${escapeHtml(getCartItemKey(item))}" type="button" aria-label="Diminuer la quantité de ${escapeHtml(item.code)}">−</button>
            <input
              class="qty-input"
              data-code="${escapeHtml(getCartItemKey(item))}"
              type="number"
              min="1"
              max="9999"
              maxlength="4"
              inputmode="numeric"
              value="${escapeHtml(item.qty || 1)}"
            />
            <button class="btn btn-secondary qty-plus" data-code="${escapeHtml(getCartItemKey(item))}" type="button" aria-label="Augmenter la quantité de ${escapeHtml(item.code)}">+</button>
            <select class="unit-select" data-code="${escapeHtml(getCartItemKey(item))}">
              <option value="Pcs" ${item.unit === 'Pcs' ? 'selected' : ''}>Pcs</option>
              <option value="m" ${item.unit === 'm' ? 'selected' : ''}>m</option>
            </select>
          </div>
        </div>
        <button class="remove-cart-item-btn" data-code="${escapeHtml(getCartItemKey(item))}" type="button" aria-label="Retirer ${escapeHtml(item.code)}">×</button>
      </div>
    `)
      .join('');

    list.querySelectorAll('.remove-cart-item-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        removeMaterialFromCart(btn.dataset.code || '');
      });
    });

    list.querySelectorAll('.qty-plus').forEach((btn) => {
      btn.addEventListener('click', () => increaseQty(btn.dataset.code || ''));
    });

    list.querySelectorAll('.qty-minus').forEach((btn) => {
      btn.addEventListener('click', () => decreaseQty(btn.dataset.code || ''));
    });

    list.querySelectorAll('.qty-input').forEach((input) => {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '');

        if (input.value.length > 4) {
          input.value = input.value.slice(0, 4);
        }

        updateQtyFromInput(input.dataset.code || '', input.value);
      });

      input.addEventListener('change', () => {
        updateQtyFromInput(input.dataset.code || '', input.value);
      });

      input.addEventListener('blur', () => {
        if (!input.value || Number(input.value) < 1) {
          input.value = '1';
        }

        updateQtyFromInput(input.dataset.code || '', input.value);
      });
    });


    list.querySelectorAll('.unit-select').forEach((select) => {
      select.addEventListener('change', () => {
        updateMaterialUnit(select.dataset.code || '', select.value);
      });
    });

    syncMaterialCartActionsState();
  }

  function formatMaterialRequestText(requestMeta = null) {
    if (!materialCart || materialCart.length === 0) {
      return 'Aucune demande de matériel.';
    }

    const mainTitle = buildRequestMainTitle(requestMeta?.requestTitle);
    const createdAtLabel = requestMeta?.createdAtLabel || formatRequestDateTime(new Date());

    let text = `📦 ${mainTitle}\n`;
    text += `${createdAtLabel}\n\n`;
    text += 'Code | Désignation | Qté | Unité\n';
    text += '----------------------------------\n';

    materialCart.forEach((item) => {
      const code = item.code || '';
      const designation = item.designation || '';
      const qty = item.qty || 1;
      const unit = item.unit || 'Pcs';

      text += `${code} | ${designation} | ${qty} | ${unit}\n`;
    });

    return text;
  }

  function copyMaterialRequest() {
    const text = formatMaterialRequestText(lastRequestMeta);
    const showToast = window.UiService?.showToast;

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => showToast?.('Demande copiée ✔'))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    window.UiService?.showToast?.('Demande copiée ✔');
  }

  function sanitizeText(text) {
    if (!text) return '';

    return String(text)
      .normalize('NFC')
      .replace(/�/g, 'É')
      .trim();
  }

  function buildRequestExportArea(requestMeta) {
    const exportArea = document.createElement('div');
    exportArea.id = 'requestExportArea';

    exportArea.style.position = 'fixed';
    exportArea.style.left = '-9999px';
    exportArea.style.top = '0';
    exportArea.style.width = '900px';
    exportArea.style.background = '#ffffff';
    exportArea.style.padding = '32px';
    exportArea.style.fontFamily = "'Segoe UI', Roboto, Arial, sans-serif";
    exportArea.style.color = '#111827';

    exportArea.innerHTML = `
      <h1 style="margin:0;font-size:28px;font-weight:800;">
        ${escapeHtml(sanitizeText(buildRequestMainTitle(requestMeta?.requestTitle)))}
      </h1>
      <p style="margin:6px 0 20px;font-size:18px;color:#334155;">${escapeHtml(sanitizeText(requestMeta?.createdAtLabel || formatRequestDateTime(new Date())))}</p>
      <table style="width:100%;border-collapse:collapse;font-size:20px;">
        <thead>
          <tr style="background:#eef5fb;">
            <th style="text-align:center;padding:16px;border:1px solid #cbd5e1;width:52px;">#</th>
            <th style="text-align:left;padding:16px;border:1px solid #cbd5e1;">Code</th>
            <th style="text-align:left;padding:16px;border:1px solid #cbd5e1;">Désignation</th>
            <th style="text-align:center;padding:16px;border:1px solid #cbd5e1;">Qté</th>
            <th style="text-align:center;padding:16px;border:1px solid #cbd5e1;">Unité</th>
          </tr>
        </thead>
        <tbody>
          ${materialCart.map((item, index) => `
            <tr>
              <td style="padding:14px;border:1px solid #cbd5e1;text-align:center;width:52px;">${index + 1}</td>
              <td style="padding:14px;border:1px solid #cbd5e1;">${escapeHtml(sanitizeText(item.code) || '-')}</td>
              <td style="padding:14px;border:1px solid #cbd5e1;">${escapeHtml(sanitizeText(item.designation) || '-')}</td>
              <td style="padding:14px;border:1px solid #cbd5e1;text-align:center;">${item.qty || 1}</td>
              <td style="padding:14px;border:1px solid #cbd5e1;text-align:center;">${escapeHtml(sanitizeText(item.unit) || 'Pcs')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    document.body.appendChild(exportArea);
    return exportArea;
  }

  function formatFileNameDatePart(value) {
    return String(value).padStart(2, '0');
  }

  function getDefaultRequestPngFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = formatFileNameDatePart(now.getMonth() + 1);
    const day = formatFileNameDatePart(now.getDate());
    const hours = formatFileNameDatePart(now.getHours());
    const minutes = formatFileNameDatePart(now.getMinutes());
    const seconds = formatFileNameDatePart(now.getSeconds());

    return `demande-materiel-${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
  }

  function updateExportTitleCounter() {
    const input = requireElement('exportTitleInput');
    const counter = requireElement('exportTitleCounter');
    if (!input || !counter) {
      return;
    }
    const maxLength = input.maxLength > 0 ? input.maxLength : 25;
    if (input.value.length > maxLength) {
      input.value = input.value.slice(0, maxLength);
    }
    const currentLength = input.value.length;
    counter.textContent = `${currentLength} / ${maxLength}`;
    counter.classList.remove('is-warning', 'is-limit');
    if (currentLength >= maxLength) {
      counter.classList.add('is-limit');
    } else if (currentLength / maxLength >= 0.8) {
      counter.classList.add('is-warning');
    }
  }


  const LAST_TITLE_KEY = 'lastMaterialRequestTitle';

  function preloadLastRequestTitle() {
    const input = requireElement('exportTitleInput');

    if (!input) return;

    const savedTitle = localStorage.getItem(LAST_TITLE_KEY);

    if (savedTitle) {
      input.value = savedTitle;

      // garder le compteur existant synchronisé
      input.dispatchEvent(new Event('input'));
    }
  }

  function saveLastRequestTitle() {
    const input = requireElement('exportTitleInput');

    if (!input) return;

    const value = input.value.trim();

    if (value) {
      localStorage.setItem(LAST_TITLE_KEY, value);
    }
  }

  function resetRequestPngModalState() {
    const input = requireElement('exportTitleInput');
    const error = requireElement('exportTitleError');
    input?.classList.remove('is-error', 'is-shaking');
    if (error) {
      error.textContent = '';
    }
    updateExportTitleCounter();
  }

  function openRequestPngModal() {
    closeMaterialCartModal?.();
    requireElement('materialCartModal')?.classList.remove('active', 'open', 'show');
    requireElement('materialCartModal')?.classList.add('hidden');

    const input = requireElement('exportTitleInput');
    resetRequestPngModalState();
    preloadLastRequestTitle();
    openDialogById('requestPngModal');
    window.setTimeout(() => {
      input?.focus();
      input?.select();
    }, 150);
  }

  function closeRequestPngModal() {
    closeDialogById('requestPngModal');
    resetRequestPngModalState();
  }

  function setRequestPngLoadingState(isLoading) {
    const confirmButton = requireElement('confirmRequestPngBtn');
    if (!confirmButton) {
      return;
    }

    const isBusy = Boolean(isLoading);
    const loader = confirmButton.querySelector('.btn-loader');
    const text = confirmButton.querySelector('.btn-text');
    const modalContent = document.querySelector('#requestPngModal .modal-content');

    confirmButton.disabled = isBusy;
    confirmButton.classList.toggle('is-disabled-soft', isBusy);
    confirmButton.classList.toggle('loading', isBusy);

    if (loader) {
      loader.classList.toggle('hidden', !isBusy);
    }

    if (text) {
      text.textContent = isBusy ? 'Génération...' : 'Télécharger';
    } else {
      confirmButton.textContent = isBusy ? 'Génération...' : 'Télécharger';
    }

    if (modalContent) {
      modalContent.classList.toggle('is-exporting', isBusy);
    }
  }

  

  const previewZoomState = {
    scale: 1,
    minScale: 1,
    maxScale: 4,
    translateX: 0,
    translateY: 0,
    activePointers: new Map(),
    pinchDistance: 0,
    pinchScaleStart: 1,
    panStartX: 0,
    panStartY: 0,
    translateStartX: 0,
    translateStartY: 0
  };

  function applyPreviewTransform() {
    const image = requireElement('requestPngPreviewImage');
    if (!image) return;
    image.style.transform = `translate(${previewZoomState.translateX}px, ${previewZoomState.translateY}px) scale(${previewZoomState.scale})`;
    image.style.cursor = previewZoomState.scale > 1 ? 'grab' : 'default';
  }

  function resetPreviewZoom() {
    previewZoomState.scale = 1;
    previewZoomState.translateX = 0;
    previewZoomState.translateY = 0;
    previewZoomState.activePointers.clear();
    previewZoomState.pinchDistance = 0;
    applyPreviewTransform();
  }

  function getPointerDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.hypot(dx, dy);
  }

  function initPreviewZoomHandlers() {
    const image = requireElement('requestPngPreviewImage');
    if (!image || image.dataset.zoomBound === '1') return;

    image.dataset.zoomBound = '1';
    image.style.touchAction = 'none';

    image.addEventListener('pointerdown', (event) => {
      image.setPointerCapture?.(event.pointerId);
      previewZoomState.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (previewZoomState.activePointers.size === 1 && previewZoomState.scale > 1) {
        previewZoomState.panStartX = event.clientX;
        previewZoomState.panStartY = event.clientY;
        previewZoomState.translateStartX = previewZoomState.translateX;
        previewZoomState.translateStartY = previewZoomState.translateY;
      }

      if (previewZoomState.activePointers.size === 2) {
        const [p1, p2] = Array.from(previewZoomState.activePointers.values());
        previewZoomState.pinchDistance = getPointerDistance(p1, p2);
        previewZoomState.pinchScaleStart = previewZoomState.scale;
      }
    });

    image.addEventListener('pointermove', (event) => {
      if (!previewZoomState.activePointers.has(event.pointerId)) return;
      previewZoomState.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (previewZoomState.activePointers.size === 2) {
        const [p1, p2] = Array.from(previewZoomState.activePointers.values());
        const distance = getPointerDistance(p1, p2);
        if (previewZoomState.pinchDistance > 0) {
          const nextScale = previewZoomState.pinchScaleStart * (distance / previewZoomState.pinchDistance);
          previewZoomState.scale = Math.min(previewZoomState.maxScale, Math.max(previewZoomState.minScale, nextScale));
          applyPreviewTransform();
        }
        event.preventDefault();
        return;
      }

      if (previewZoomState.activePointers.size === 1 && previewZoomState.scale > 1) {
        previewZoomState.translateX = previewZoomState.translateStartX + (event.clientX - previewZoomState.panStartX);
        previewZoomState.translateY = previewZoomState.translateStartY + (event.clientY - previewZoomState.panStartY);
        applyPreviewTransform();
        event.preventDefault();
      }
    });

    const clearPointer = (event) => {
      previewZoomState.activePointers.delete(event.pointerId);
      if (previewZoomState.activePointers.size < 2) previewZoomState.pinchDistance = 0;
      if (previewZoomState.scale <= 1) {
        previewZoomState.translateX = 0;
        previewZoomState.translateY = 0;
        applyPreviewTransform();
      }
    };

    image.addEventListener('pointerup', clearPointer);
    image.addEventListener('pointercancel', clearPointer);
  }

  function setRequestPngPreviewImage(dataUrl) {
    const image = requireElement('requestPngPreviewImage');
    if (image) {
      image.src = String(dataUrl || '');
    }
  }

  function openRequestPngPreviewModal(dataUrl) {
    setRequestPngPreviewImage(dataUrl);
    initPreviewZoomHandlers();
    resetPreviewZoom();
    openDialogById('requestPngPreviewModal');
  }

  function closeRequestPngPreviewModal() {
    resetPreviewZoom();
    closeDialogById('requestPngPreviewModal');
  }

  async function downloadRequestAsPng(customTitle = '') {
    const showToast = window.UiService?.showToast;

    if (!materialCart || materialCart.length === 0) {
      showToast?.('Aucune demande à télécharger');
      return;
    }

    if (typeof window.html2canvas !== 'function') {
      showToast?.('Export PNG indisponible');
      return;
    }

    let exportArea = null;

    try {
      const requestMeta = await createMaterialRequestRecord(customTitle);
      lastRequestMeta = requestMeta;
      exportArea = buildRequestExportArea(requestMeta);
      const canvas = await window.html2canvas(exportArea, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
        width: exportArea.scrollWidth,
        height: exportArea.scrollHeight,
        windowWidth: exportArea.scrollWidth,
        windowHeight: exportArea.scrollHeight
      });

      const safeFileName = getDefaultRequestPngFileName();
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `${safeFileName}.png`;
      link.href = dataUrl;
      link.click();

      openRequestPngPreviewModal(dataUrl);
    } catch (error) {
      console.error('Erreur export PNG :', error);
      showToast?.('Erreur téléchargement PNG');
    } finally {
      exportArea?.remove();
    }
  }

  function openDialogById(id) {
    const modal = requireElement(id);
    if (!modal || typeof modal.showModal !== 'function') {
      return;
    }
    if (!modal.open) {
      modal.showModal();
    }
  }

  function closeDialogById(id) {
    const modal = requireElement(id);
    if (!modal || typeof modal.close !== 'function') {
      return;
    }
    if (modal.open) {
      modal.close();
    }
  }

  function openMaterialCartModal() {
    requireElement('materialCartModal')?.classList.remove('hidden');
    openDialogById('materialCartModal');
  }

  function closeMaterialCartModal() {
    closeDialogById('materialCartModal');
  }

  function openManualMaterialModal() {
    const errorEl = requireElement('manualMaterialError');
    clearTimeout(errorEl?._hideTimer);
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.remove('visible');
    }
    ['manualMaterialCodeInput', 'manualMaterialDesignationInput'].forEach((id) => {
      requireElement(id)?.classList.remove('input-error', 'shake');
    });
    requireElement('manualMaterialCodeInput').value = '';
    requireElement('manualMaterialDesignationInput').value = '';
    openDialogById('manualMaterialModal');
    window.setTimeout(() => requireElement('manualMaterialDesignationInput')?.focus(), 100);
  }

  function closeManualMaterialModal() {
    closeDialogById('manualMaterialModal');
  }

  function showTempFieldError(input, errorEl, message) {
    if (!input || !errorEl) {
      return;
    }

    input.classList.add('input-error');
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');

    errorEl.textContent = message;
    errorEl.classList.add('visible');

    clearTimeout(errorEl._hideTimer);
    errorEl._hideTimer = window.setTimeout(() => {
      errorEl.textContent = '';
      errorEl.classList.remove('visible');
      input.classList.remove('input-error');
    }, 2500);
  }

  function validateManualMaterialForm() {
    const designationInput = requireElement('manualMaterialDesignationInput');
    const errorEl = requireElement('manualMaterialError');

    const designation = String(designationInput?.value || '').trim();
    if (!designation) {
      showTempFieldError(designationInput, errorEl, 'La désignation est obligatoire.');
      designationInput?.focus();
      return null;
    }

    return { designation, qty: 1, unit: 'Pcs' };
  }

  function saveManualMaterial() {
    const code = String(requireElement('manualMaterialCodeInput')?.value || '').trim();
    const valid = validateManualMaterialForm();
    if (!valid) {
      return;
    }
    const { designation, qty, unit } = valid;
    const manualItem = { code, designation, qty, unit, manual: true };
    const existing = materialCart.find((item) => String(item.code || '').trim() === code && code);
    if (existing) {
      existing.qty = sanitizeQty((Number(existing.qty) || 0) + qty);
      if (!String(existing.designation || '').trim()) {
        existing.designation = designation;
      }
      if (!String(existing.unit || '').trim()) {
        existing.unit = unit;
      }
    } else {
      if (materialCart.length >= MAX_CART_LINES) {
        window.UiService?.showToast?.('Limite de 20 matériels atteinte.');
        return;
      }
      materialCart.push({
        ...manualItem,
        manualKey: code || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }

    saveMaterialCart();
    updateMaterialCartBadge();
    renderMaterialCart();
    closeManualMaterialModal();
    openMaterialCartModal();
  }

    function renderMaterials(materials) {
    const tbody = document.querySelector('#materialsTableBody');

    if (!tbody) {
      console.error('#materialsTableBody introuvable');
      return;
    }

    const safeMaterials = Array.isArray(materials) ? materials : [];
    displayedMaterials = safeMaterials;
    const countNumber = document.querySelector('#materialsCount .count-number');
    const emptyState = requireElement('materialsEmptyState');
    const table = requireElement('materialsDataTable');

    if (countNumber) {
      countNumber.textContent = String(safeMaterials.length);
    }

    if (!safeMaterials.length) {
      tbody.innerHTML = '\n      <tr>\n        <td colspan="2">Aucun matériel disponible.</td>\n      </tr>\n    ';
      if (table) {
        table.hidden = false;
      }
      if (emptyState) {
        emptyState.hidden = true;
      }
      return;
    }

    if (emptyState) {
      emptyState.hidden = true;
    }
    if (table) {
      table.hidden = false;
    }

    tbody.innerHTML = safeMaterials.map((item) => `
    <tr class="material-row" data-code="${escapeHtml(item.code || '')}" data-designation="${escapeHtml(item.designation || '')}">
      <td>${escapeHtml(item.code || '-')}</td>
      <td>${escapeHtml(item.designation || '-')}</td>
    </tr>
  `).join('');
  }

  async function loadAllMaterials() {
    console.log('Chargement tous matériels...');
    const snap = await getDocs(collection(firebaseDb, 'pages', 'page3', 'items'));
    console.log('Documents articles trouvés :', snap.size);

    const uniqueMaterials = new Map();
    snap.forEach((docSnap) => {
      const row = normalizeMaterialRow(docSnap.data());
      if (!row.code) {
        return;
      }
      if (!uniqueMaterials.has(row.code)) {
        uniqueMaterials.set(row.code, row);
      }
    });

    const materials = Array.from(uniqueMaterials.values()).sort((a, b) =>
      String(a.designation).localeCompare(String(b.designation), 'fr', { sensitivity: 'base' }),
    );

    console.log('Matériels uniques :', materials.length);
    return materials;
  }

  async function initMaterialsPage() {
    console.log('Init materiels.html');

    const backButton = requireElement('materialsBackButton');
    const searchInput = requireElement('materialsSearchInput');
    const clearSearchBtn = requireElement('materialsClearSearchBtn');
    const exportButton = requireElement('materialsExportBtn');
    let allMaterials = [];

    backButton?.addEventListener('click', () => {
      window.location.assign('index.html');
    });

    const applySearch = () => {
      const query = String(searchInput?.value || '').trim().toLowerCase();
      if (!query) {
        renderMaterials(allMaterials);
        return;
      }
      const filtered = allMaterials.filter((material) => {
        const code = String(material.code || '').toLowerCase();
        const designation = String(material.designation || '').toLowerCase();
        return code.includes(query) || designation.includes(query);
      });
      renderMaterials(filtered);
    };

    searchInput?.addEventListener('input', applySearch);

    const toggleClearButton = () => {
      if (!searchInput || !clearSearchBtn) {
        return;
      }
      clearSearchBtn.style.display = searchInput.value.trim() ? 'flex' : 'none';
    };

    searchInput?.addEventListener('input', toggleClearButton);
    clearSearchBtn?.addEventListener('click', () => {
      if (!searchInput) {
        return;
      }
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
    });

    toggleClearButton();
    syncMaterialsExportButtonVisibility();
    window.addEventListener('app:permissions-ready', syncMaterialsExportButtonVisibility);
    exportButton?.addEventListener('click', exportDisplayedMaterials);

    initMaterialsHint();

    loadMaterialCart();
    updateMaterialCartBadge();
    syncMaterialCartActionsState();

    requireElement('materialCartFab')?.addEventListener('click', () => {
      const fab = requireElement('materialCartFab');
      if (!materialCart.length && fab) {
        fab.classList.add('bounce');
        window.setTimeout(() => {
          fab.classList.remove('bounce');
        }, 300);
      }
      renderMaterialCart();
      openMaterialCartModal();
    });

    requireElement('materialCartModal')?.addEventListener('click', (event) => {
      const modal = event.currentTarget;
      if (event.target === modal) {
        closeMaterialCartModal();
      }
    });

    requireElement('clearMaterialCartBtn')?.addEventListener('click', () => {
      materialCart = [];
      saveMaterialCart();
      updateMaterialCartBadge();
      renderMaterialCart();
    });

    requireElement('downloadRequestPngBtn')?.addEventListener('click', openRequestPngModal);
    requireElement('confirmRequestPngBtn')?.addEventListener('click', async () => {
      if (isRequestPngDownloading) {
        return;
      }

      const input = requireElement('exportTitleInput');
      const cleanedValue = String(input?.value || '').trim();

      isRequestPngDownloading = true;
      setRequestPngLoadingState(true);
      saveLastRequestTitle();
      closeRequestPngModal();

      try {
        await downloadRequestAsPng(cleanedValue);
      } finally {
        isRequestPngDownloading = false;
        setRequestPngLoadingState(false);
      }
    });
    requireElement('cancelRequestPngBtn')?.addEventListener('click', closeRequestPngModal);
    requireElement('exportTitleInput')?.addEventListener('input', () => {
      const input = requireElement('exportTitleInput');
      const error = requireElement('exportTitleError');
      if (input && input.maxLength > 0 && input.value.length > input.maxLength) {
        input.value = input.value.slice(0, input.maxLength);
      }
      updateExportTitleCounter();
      input?.classList.remove('is-error', 'is-shaking');
      if (error) {
        error.textContent = '';
      }
    });
    requireElement('exportTitleInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        requireElement('confirmRequestPngBtn')?.click();
      }
    });
    requireElement('requestPngModal')?.addEventListener('click', (event) => {
      const modal = event.currentTarget;
      if (event.target === modal) {
        closeRequestPngModal();
      }
    });
    requireElement('requestPngModal')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeRequestPngModal();
    });
    requireElement('requestPngPreviewOkBtn')?.addEventListener('click', closeRequestPngPreviewModal);
    requireElement('requestPngPreviewModal')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        event.preventDefault();
      }
    });
    requireElement('requestPngPreviewModal')?.addEventListener('cancel', (event) => {
      event.preventDefault();
    });
    requireElement('openManualMaterialBtn')?.addEventListener('click', openManualMaterialModal);
    requireElement('saveManualMaterialBtn')?.addEventListener('click', saveManualMaterial);
    requireElement('cancelManualMaterialBtn')?.addEventListener('click', closeManualMaterialModal);
    requireElement('manualMaterialDesignationInput')?.addEventListener('input', () => {
      const input = requireElement('manualMaterialDesignationInput');
      const error = requireElement('manualMaterialError');
      clearTimeout(error?._hideTimer);
      input?.classList.remove('input-error', 'shake');
      if (error) {
        error.textContent = '';
        error.classList.remove('visible');
      }
    });
    requireElement('manualMaterialModal')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeManualMaterialModal();
      }
    });
    requireElement('manualMaterialModal')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeManualMaterialModal();
    });

    requireElement('materialsTableBody')?.addEventListener('click', (event) => {
      const row = event.target.closest('tr.material-row');
      if (!row) {
        return;
      }
      const code = String(row.dataset.code || '').trim();
      if (!code) {
        return;
      }
      const designation = String(row.dataset.designation || '').trim();
      addMaterialToCart({ code, designation });
    });

    try {
      allMaterials = await loadAllMaterials();
      renderMaterials(allMaterials);
      recordMaterialsPageOpenHistoryOnce();
    } catch (error) {
      console.error('Erreur chargement tous matériels :', error);
      renderMaterials([]);
    } finally {
      window.UiService?.markAppReady?.();
      document.body.classList.remove('loading');
      document.querySelector('.global-skeleton')?.remove();
      document.querySelector('.skeleton-container')?.remove();
      document.querySelector('#skeleton')?.remove();
    }
  }

  if (isMaterialsPage) {
    initMaterialsPage();
  }
})();
