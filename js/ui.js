(function () {
  const TOAST_VISIBLE_CLASS = "toast--visible";
  const TOAST_WITH_ACTION_CLASS = "toast--with-action";
  const TOAST_TYPES = new Set(["success", "error", "warning", "info"]);
  const DEFAULT_TOAST_DURATION = 2800;
  const DEFAULT_SNACKBAR_DURATION = 5000;
  const TOAST_HIDE_ANIMATION_DURATION = 220;
  const APP_LOADED_STORAGE_KEY = "albumAppHasLoadedOnce";
  const CONTENT_PENDING_CLASS = "app-content-pending";
  const CONTENT_LOADING_CLASS = "app-content-loading";
  const CONTENT_READY_CLASS = "app-content-ready";
  const LEGACY_LOADING_CLASS = "is-loading";
  const INLINE_LOADER_ID = "pageInlineLoader";
  const CONTENT_LOADING_DELAY_MS = 120;
  let hideTimerId = null;
  let toastTimer = null;
  const toastQueue = [];
  let activeToastOptions = null;
  let hasWindowLoaded = document.readyState === "complete";
  let isAppReady = false;
  let inlineLoaderTimerId = null;

  function showGlobalLoader() {
    ensureInlineLoader();
    document.body.classList.remove(CONTENT_READY_CLASS);
    document.body.classList.add(CONTENT_LOADING_CLASS, LEGACY_LOADING_CLASS);
  }

  function hideGlobalLoader() {
    stopContentLoadingState();
  }

  function ensureInlineLoader() {
    const pageContent = document.querySelector(".page-content");
    if (!pageContent) {
      return null;
    }

    let inlineLoader = document.getElementById(INLINE_LOADER_ID);
    if (inlineLoader) {
      return inlineLoader;
    }

    inlineLoader = document.createElement("div");
    inlineLoader.id = INLINE_LOADER_ID;
    inlineLoader.className = "page-inline-loader global-skeleton";
    inlineLoader.setAttribute("aria-hidden", "true");

    const pageName = document.body?.dataset?.page || "";
    const skeletonByPage = {
      home: `
        <div class="skeleton-card skeleton-card--search"><span class="skeleton-line skeleton-line--input"></span></div>
        <div class="skeleton-heading-row">
          <span class="skeleton-line skeleton-line--heading"></span>
          <span class="skeleton-pill"></span>
        </div>
        <div class="skeleton-card skeleton-card--list">
          <span class="skeleton-line skeleton-line--title"></span>
          <span class="skeleton-line skeleton-line--meta"></span>
          <span class="skeleton-line skeleton-line--meta"></span>
          <span class="skeleton-line skeleton-line--meta"></span>
          <span class="skeleton-divider"></span>
          <span class="skeleton-line skeleton-line--lock"></span>
        </div>
      `,
      "site-detail": `
        <div class="skeleton-card skeleton-card--search"><span class="skeleton-line skeleton-line--input"></span></div>
        <div class="skeleton-chip-row">
          <span class="skeleton-chip"></span><span class="skeleton-chip"></span><span class="skeleton-chip"></span><span class="skeleton-chip"></span>
        </div>
        <div class="skeleton-separator"><span class="skeleton-line skeleton-line--separator"></span></div>
        <div class="skeleton-card skeleton-card--list"><span class="skeleton-line skeleton-line--title"></span><span class="skeleton-line skeleton-line--meta"></span><span class="skeleton-line skeleton-line--meta"></span><span class="skeleton-line skeleton-line--meta"></span></div>
        <div class="skeleton-card skeleton-card--list"><span class="skeleton-line skeleton-line--title"></span><span class="skeleton-line skeleton-line--meta"></span><span class="skeleton-line skeleton-line--meta"></span><span class="skeleton-line skeleton-line--meta"></span></div>
      `,
      "item-detail": `
        <div class="skeleton-card skeleton-card--table-wrap">
          <div class="skeleton-table-header">
            <div><span class="skeleton-line skeleton-line--table-title"></span><span class="skeleton-line skeleton-line--meta"></span><span class="skeleton-line skeleton-line--meta"></span></div>
            <span class="skeleton-button"></span>
          </div>
          <div class="skeleton-card skeleton-card--search-inline"><span class="skeleton-line skeleton-line--input"></span></div>
          <div class="skeleton-table-head"></div>
          <div class="skeleton-table-row"><span class="skeleton-index"></span><span class="skeleton-cell"></span><span class="skeleton-cell"></span></div>
          <div class="skeleton-table-row"><span class="skeleton-index"></span><span class="skeleton-cell"></span><span class="skeleton-cell"></span></div>
          <div class="skeleton-table-row"><span class="skeleton-index"></span><span class="skeleton-cell"></span><span class="skeleton-cell"></span></div>
        </div>
      `,
    };
    inlineLoader.innerHTML = skeletonByPage[pageName] || `<div class="page-inline-loader__block page-inline-loader__block--title"></div>`;
    pageContent.prepend(inlineLoader);
    return inlineLoader;
  }

  function startContentLoadingState() {
    document.body.classList.add(CONTENT_PENDING_CLASS, LEGACY_LOADING_CLASS);
    document.body.classList.remove(CONTENT_LOADING_CLASS, CONTENT_READY_CLASS);

    inlineLoaderTimerId = window.setTimeout(() => {
      if (isAppReady) {
        return;
      }
      ensureInlineLoader();
      document.body.classList.add(CONTENT_LOADING_CLASS, LEGACY_LOADING_CLASS);
    }, CONTENT_LOADING_DELAY_MS);
  }

  function stopContentLoadingState() {
    if (inlineLoaderTimerId) {
      window.clearTimeout(inlineLoaderTimerId);
      inlineLoaderTimerId = null;
    }
    document.body.classList.remove(CONTENT_PENDING_CLASS, CONTENT_LOADING_CLASS, LEGACY_LOADING_CLASS);
    document.body.classList.add(CONTENT_READY_CLASS);
  }

  function waitForImagesReady() {
    const pendingImages = Array.from(document.images).filter((image) => !image.complete);
    if (pendingImages.length === 0) {
      return Promise.resolve();
    }

    return Promise.all(
      pendingImages.map(
        (image) =>
          new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }),
      ),
    ).then(() => undefined);
  }

  function maybeHideGlobalLoader() {
    if (!hasWindowLoaded || !isAppReady) {
      return;
    }

    waitForImagesReady().then(hideGlobalLoader);
  }

  function markAppReady() {
    isAppReady = true;
    stopContentLoadingState();
    try {
      sessionStorage.setItem(APP_LOADED_STORAGE_KEY, "1");
    } catch (_error) {
      // Ignore storage restrictions.
    }
    maybeHideGlobalLoader();
  }

  function formatDate(dateValue) {
    if (!dateValue) {
      return "--";
    }
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(dateValue));
  }

  function getQueryParams() {
    return new URLSearchParams(window.location.search);
  }

  function createTypeIcon(type) {
    const icon = document.createElement("span");
    icon.className = "toast__icon";
    icon.setAttribute("aria-hidden", "true");

    const iconByType = {
      success: "✓",
      error: "⚠",
      warning: "!",
      info: "i",
    };

    icon.textContent = iconByType[type] || iconByType.info;
    return icon;
  }

  function inferToastType(message) {
    const normalizedMessage = String(message ?? "").toLowerCase();
    if (/(impossible|erreur|échec|invalide|indisponible)/.test(normalizedMessage)) {
      return "error";
    }
    if (/(attention|avertissement|verrouillé)/.test(normalizedMessage)) {
      return "warning";
    }
    if (/(succès|succ[eé]d|supprim|ajout|mis [àa] jour|import|export|lanc[ée])/.test(normalizedMessage)) {
      return "success";
    }
    return "info";
  }

  function normalizeToastOptions(messageOrOptions, maybeOptions = {}) {
    if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
      const options = { ...messageOrOptions };
      options.message = String(options.message ?? "");
      const safeType = TOAST_TYPES.has(options.type) ? options.type : inferToastType(options.message);
      options.type = safeType;
      options.duration = Number.isFinite(options.duration) ? Number(options.duration) : DEFAULT_TOAST_DURATION;
      return options;
    }

    const message = String(messageOrOptions ?? "");
    const options = { ...maybeOptions, message };
    const safeType = TOAST_TYPES.has(options.type) ? options.type : inferToastType(message);
    options.type = safeType;
    options.duration = Number.isFinite(options.duration) ? Number(options.duration) : DEFAULT_TOAST_DURATION;
    return options;
  }

  function getToastElement() {
    let toast = document.getElementById("toast");
    if (toast) {
      toast.classList.add("toast");
      return toast;
    }

    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.setAttribute("aria-atomic", "true");
    document.body.appendChild(toast);
    return toast;
  }

  function hideToast() {
    const toast = getToastElement();
    if (!toast) {
      return;
    }

    if (hideTimerId) {
      window.clearTimeout(hideTimerId);
      hideTimerId = null;
    }
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }

    toast.classList.remove(TOAST_VISIBLE_CLASS, TOAST_WITH_ACTION_CLASS);
    toast.removeAttribute("data-type");
    toastTimer = window.setTimeout(() => {
      if (!toast.classList.contains(TOAST_VISIBLE_CLASS)) {
        toast.textContent = "";
      }
      activeToastOptions = null;
      toastTimer = null;
      processToastQueue();
    }, TOAST_HIDE_ANIMATION_DURATION);
  }

  function scheduleHide(delay = DEFAULT_TOAST_DURATION) {
    if (hideTimerId) {
      window.clearTimeout(hideTimerId);
    }
    hideTimerId = window.setTimeout(() => {
      hideTimerId = null;
      hideToast();
    }, delay);
  }

  function processToastQueue() {
    if (activeToastOptions || toastQueue.length === 0) {
      return;
    }
    activeToastOptions = toastQueue.shift();
    renderToast(activeToastOptions);
  }

  function renderToast(options) {
    const toast = getToastElement();
    if (!toast) {
      return;
    }

    const { message, type = "info", actionLabel, onAction } = options;
    const hasAction = typeof onAction === "function";

    toast.textContent = "";
    toast.classList.toggle(TOAST_WITH_ACTION_CLASS, hasAction);
    toast.dataset.type = type;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    const content = document.createElement("div");
    content.className = "toast__content";

    content.appendChild(createTypeIcon(type));

    const messageNode = document.createElement("span");
    messageNode.className = "toast__message";
    messageNode.textContent = String(message ?? "");
    content.appendChild(messageNode);

    toast.appendChild(content);

    if (hasAction) {
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.className = "toast__action";
      actionButton.textContent = actionLabel || "Annuler";
      actionButton.addEventListener(
        "click",
        () => {
          onAction();
          hideToast();
        },
        { once: true },
      );
      toast.appendChild(actionButton);
    }

    toast.classList.add(TOAST_VISIBLE_CLASS);
    scheduleHide(options.duration);
  }

  function showToast(messageOrOptions, maybeOptions = {}) {
    const options = normalizeToastOptions(messageOrOptions, maybeOptions);
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (hideTimerId) {
      window.clearTimeout(hideTimerId);
      hideTimerId = null;
    }

    if (activeToastOptions) {
      activeToastOptions = options;
      renderToast(activeToastOptions);
      return;
    }

    toastQueue.push(options);
    processToastQueue();
  }

  function showUndoSnackbar(message, onUndo, actionLabel = "Annuler") {
    const options = normalizeToastOptions(message, {
      type: "warning",
      duration: DEFAULT_SNACKBAR_DURATION,
      actionLabel,
      onAction: onUndo,
    });
    toastQueue.push(options);
    processToastQueue();
  }

  function renderEmptyState(container, message) {
    container.innerHTML = `<div class="empty-state">${message}</div>`;
  }

  function bindDialogCloser() {
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => {
        button.closest("dialog")?.close();
      });
    });
  }

  function navigate(url) {
    window.requestAnimationFrame(() => {
      window.location.href = url;
    });
  }

  try {
    sessionStorage.getItem(APP_LOADED_STORAGE_KEY);
  } catch (_error) {
    // Ignore storage restrictions.
  }
  startContentLoadingState();

  window.addEventListener("load", () => {
    hasWindowLoaded = true;
    maybeHideGlobalLoader();
  });

  window.UiService = {
    formatDate,
    getQueryParams,
    showToast,
    showUndoSnackbar,
    renderEmptyState,
    bindDialogCloser,
    navigate,
    showGlobalLoader,
    hideGlobalLoader,
    markAppReady,
  };
})();
