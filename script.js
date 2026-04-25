const UPLOAD_ENDPOINT = "https://back-end-serveur-1.onrender.com/upload";
const EXCEL_TO_JSON_ENDPOINT = "https://back-end-serveur-1.onrender.com/api/excel-to-json";
const API_BASE = "https://back-end-serveur-1.onrender.com";

const isIndexPage = Boolean(document.getElementById("uploadForm"));
const isDownloadPage = Boolean(document.getElementById("downloadInfo"));

if (isIndexPage) {
  setupUploadPage();
}

if (isDownloadPage) {
  setupDownloadPage();
}

function setupUploadPage() {
  const uploadForm = document.getElementById("uploadForm");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const selectedFile = document.getElementById("selectedFile");
  const uploadBtn = document.getElementById("uploadBtn");
  const statusMessage = document.getElementById("statusMessage");
  const result = document.getElementById("result");
  const downloadLink = document.getElementById("downloadLink");
  const copyBtn = document.getElementById("copyBtn");
  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const excelForm = document.getElementById("excelForm");
  const excelInput = document.getElementById("excelInput");
  const excelSelectedFile = document.getElementById("excelSelectedFile");
  const excelBtn = document.getElementById("excelBtn");
  const excelStatus = document.getElementById("excelStatus");

  let progressTimer = null;

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    selectedFile.textContent = file ? `Fichier sélectionné : ${file.name}` : "Aucun fichier sélectionné";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    selectedFile.textContent = `Fichier sélectionné : ${file.name}`;
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileInput.files?.[0];
    if (!file) {
      showStatus(statusMessage, "error", "Veuillez sélectionner un fichier avant l'envoi.");
      return;
    }

    result.classList.add("hidden");
    showStatus(statusMessage, "info", "Upload en cours...");
    uploadBtn.disabled = true;
    startFakeProgress(progressWrap, progressBar);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(UPLOAD_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Erreur serveur");
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("Erreur de format");
      }

      console.debug("Réponse brute du serveur:", data);

      const finalLink = data?.download_url;
      if (!finalLink) {
        throw new Error("Réponse inattendue du serveur");
      }

      showStatus(statusMessage, "success", "Upload terminé.");
      progressBar.style.width = "100%";
      downloadLink.href = finalLink;
      downloadLink.textContent = finalLink;
      result.classList.remove("hidden");
    } catch (error) {
      const knownMessages = new Set(["Erreur serveur", "Erreur de format", "Réponse inattendue du serveur"]);
      const rawMessage = error instanceof Error ? error.message : "";
      const errorMessage = knownMessages.has(rawMessage) ? rawMessage : "Erreur serveur";
      showStatus(statusMessage, "error", errorMessage);
    } finally {
      uploadBtn.disabled = false;
      stopFakeProgress(progressWrap, progressBar, progressTimer);
      progressTimer = null;
    }
  });

  copyBtn.addEventListener("click", async () => {
    const link = downloadLink.textContent?.trim();
    if (!link) return;

    try {
      await navigator.clipboard.writeText(link);
      showStatus(statusMessage, "success", "Lien copié dans le presse-papiers.");
    } catch {
      showStatus(statusMessage, "error", "Impossible de copier automatiquement le lien.");
    }
  });

  if (excelForm && excelInput && excelSelectedFile && excelBtn && excelStatus) {
    excelInput.addEventListener("change", () => {
      const file = excelInput.files?.[0];
      excelSelectedFile.textContent = file ? `Fichier sélectionné : ${file.name}` : "Aucun fichier sélectionné";
    });

    excelForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const file = excelInput.files?.[0];
      if (!file) {
        showStatus(excelStatus, "error", "Veuillez sélectionner un fichier Excel avant la transformation.");
        return;
      }

      const initialButtonText = "Transformer en JSON";
      excelBtn.disabled = true;
      excelBtn.textContent = "Traitement en cours...";
      showStatus(excelStatus, "info", "Traitement en cours...");

      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch(EXCEL_TO_JSON_ENDPOINT, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error("Le serveur a retourné une erreur pendant la transformation.");
        }

        const jsonBlob = await response.blob();
        const downloadUrl = URL.createObjectURL(jsonBlob);
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = "suggestions.json";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(downloadUrl);

        showStatus(excelStatus, "success", "Transformation terminée. Le téléchargement de suggestions.json a démarré.");
      } catch {
        showStatus(excelStatus, "error", "Impossible de transformer le fichier. Vérifiez le format Excel puis réessayez.");
      } finally {
        excelBtn.disabled = false;
        excelBtn.textContent = initialButtonText;
      }
    });
  }

  function startFakeProgress(wrapper, bar) {
    wrapper.style.display = "block";
    bar.style.width = "6%";
    let value = 6;

    progressTimer = setInterval(() => {
      if (value >= 90) return;
      value += Math.random() * 12;
      bar.style.width = `${Math.min(value, 90)}%`;
    }, 300);
  }
}

function stopFakeProgress(wrapper, bar, timerRef) {
  if (timerRef) {
    clearInterval(timerRef);
  }

  setTimeout(() => {
    wrapper.style.display = "none";
    bar.style.width = "0";
  }, 600);
}

function showStatus(element, type, text) {
  element.className = "status";
  element.classList.add(type);
  element.textContent = text;
}

async function setupDownloadPage() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  const status = document.getElementById("downloadStatus");
  const info = document.getElementById("downloadInfo");
  const fileName = document.getElementById("fileName");
  const downloadBtn = document.getElementById("downloadBtn");

  if (!id) {
    showStatus(status, "error", "Aucun identifiant de fichier fourni dans l'URL.");
    return;
  }

  showStatus(status, "info", "Chargement des informations du fichier...");

  const endpoint = `${API_BASE}/download/${encodeURIComponent(id)}`;

  try {
    const response = await fetch(endpoint, { method: "GET" });

    if (!response.ok) {
      throw new Error("Fichier introuvable ou indisponible.");
    }

    const data = await response.json();
    const serverFileName = data.fileName || data.name || `fichier-${id}`;
    const directUrl = data.url || endpoint;

    fileName.textContent = serverFileName;
    downloadBtn.href = directUrl;
    info.classList.remove("hidden");
    showStatus(status, "success", "Votre fichier est prêt.");
  } catch (error) {
    showStatus(status, "error", error.message || "Erreur lors de la récupération du fichier.");
  }
}
