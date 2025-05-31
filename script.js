const noteInput = document.getElementById("noteInput");
const listeNotes = document.getElementById("listeNotes");

// Charger les notes depuis localStorage
let notes = JSON.parse(localStorage.getItem("notes")) || [];
afficherNotes();

// Détection de la touche Entrée
noteInput.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); // Empêche le retour à la ligne
    const texte = noteInput.value.trim();
    if (texte !== "") {
      notes.push(texte);
      noteInput.value = "";
      sauvegarder();
      afficherNotes();
    }
  }
});

// Sauvegarder dans localStorage
function sauvegarder() {
  localStorage.setItem("notes", JSON.stringify(notes));
}

// Afficher les notes
function afficherNotes() {
  listeNotes.innerHTML = "";
  notes.forEach(note => {
    const li = document.createElement("li");
    li.textContent = note;
    listeNotes.appendChild(li);
  });
}
