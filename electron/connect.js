const localButton = document.querySelector('#localButton');
const remoteButton = document.querySelector('#remoteButton');
const remoteForm = document.querySelector('#remoteForm');
const serverUrl = document.querySelector('#serverUrl');
const message = document.querySelector('#launchMessage');

const dragHandle = document.querySelector('.brand');
if (typeof window.nextermLauncher.dragWindow === 'function' && dragHandle) {
  let dragPointerId = null;
  const finishDrag = event => {
    if (event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    window.nextermLauncher.dragWindow('end');
    if (dragHandle.hasPointerCapture(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId);
  };
  dragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button, a, input, select, textarea')) return;
    dragPointerId = event.pointerId;
    dragHandle.setPointerCapture(dragPointerId);
    window.nextermLauncher.dragWindow('start', { x: event.screenX, y: event.screenY });
    event.preventDefault();
  });
  dragHandle.addEventListener('pointermove', event => {
    if (event.pointerId === dragPointerId) window.nextermLauncher.dragWindow('move', { x: event.screenX, y: event.screenY });
  });
  dragHandle.addEventListener('pointerup', finishDrag);
  dragHandle.addEventListener('pointercancel', finishDrag);
  dragHandle.addEventListener('lostpointercapture', finishDrag);
}

function setBusy(text) {
  localButton.disabled = true;
  remoteButton.disabled = true;
  message.hidden = false;
  message.classList.remove('error');
  message.textContent = text;
}

function setError(text) {
  localButton.disabled = false;
  remoteButton.disabled = false;
  message.hidden = false;
  message.classList.add('error');
  message.textContent = text;
}

window.nextermLauncher.onStatus(setBusy);
window.nextermLauncher.onError(setError);
window.nextermLauncher.getSettings().then(settings => {
  if (settings.serverUrl) serverUrl.value = settings.serverUrl;
}).catch(() => {});

localButton.addEventListener('click', async () => {
  setBusy('Tresor wird vorbereitet …');
  const result = await window.nextermLauncher.useLocalVault();
  if (!result?.ok) {
    localButton.disabled = false;
    remoteButton.disabled = false;
  }
});

remoteForm.addEventListener('submit', async event => {
  event.preventDefault();
  setBusy('Webserver wird geöffnet …');
  const result = await window.nextermLauncher.connectServer(serverUrl.value);
  if (!result?.ok) {
    localButton.disabled = false;
    remoteButton.disabled = false;
  }
});
