import { GlobalWindow } from 'happy-dom';

if (!globalThis.window) {
  const win = new GlobalWindow();
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    location: win.location,
    history: win.history,
    DOMParser: win.DOMParser,
    MutationObserver: win.MutationObserver,
  });
}

