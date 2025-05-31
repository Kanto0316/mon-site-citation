const noteInput = document.getElementById("noteInput");
const listeNotes = document.getElementById("listeNotes");

// Charger les notes depuis localStorage
let notes = JSON.parse(localStorage.getItem("notes")) || [];
afficherNotes();

// Quand on appuie sur Entrée
noteInput.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && noteInput.value.trim() !== "") {
    notes.push(noteInput.value.trim());
    noteInput.value = "";
    sauvegarder();
    afficherNotes();
  }
});

// Sauvegarder dans localStorage
function sauvegarder() {
  localStorage.setItem("notes", JSON.stringify(notes));
}

// Afficher les notes dans la liste
function afficherNotes() {
  listeNotes.innerHTML = "";
  notes.forEach(note => {
    const li = document.createElement("li");
    li.textContent = note;
    listeNotes.appendChild(li);
  });
}
