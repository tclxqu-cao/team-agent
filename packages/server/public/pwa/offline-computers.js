import { readComputers, readComputerHandoff, mergeComputers, saveComputers, computerNavigation } from "./computer-directory.js";

let computers = readComputers();
// The target can go offline after the user starts switching. Keep its handoff
// directory locally, but never record the unconfirmed target or a QR grant.
try { computers = saveComputers(mergeComputers(computers, readComputerHandoff(location.hash).computers)); } catch {}
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
const section = document.getElementById("known-computers"), selector = document.getElementById("computer");
for (const computer of computers) {
  const option = document.createElement("option");
  option.value = computer.origin; option.textContent = computer.name;
  selector.append(option);
}
section.hidden = !computers.length;
selector.addEventListener("change", () => { if (selector.value) location.assign(computerNavigation(selector.value, computers)); });
