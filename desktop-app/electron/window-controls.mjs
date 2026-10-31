export const windowState = window => ({ fullscreen: window.isFullScreen(), maximized: window.isMaximized() });

export function windowAction(window, action) {
  if (window.isDestroyed()) return;
  switch (action) {
    case 'minimize': window.minimize(); break;
    case 'toggle-maximize':
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      break;
    case 'close': window.close(); return;
    case 'state': break;
    default: throw new Error('Invalid window action');
  }
  return windowState(window);
}
