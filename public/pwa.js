(function () {
  let deferredPrompt = null;
  let installButton = null;

  function ensureInstallButton() {
    if (installButton) {
      return installButton;
    }

    installButton = document.createElement('button');
    installButton.type = 'button';
    installButton.textContent = 'Instalar aplicación';
    installButton.setAttribute('aria-label', 'Instalar Antojitos Los Anafres');

    Object.assign(installButton.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '9998',
      border: 'none',
      borderRadius: '999px',
      padding: '12px 16px',
      background: '#C73E1D',
      color: '#ffffff',
      font: '800 14px Nunito, Arial, sans-serif',
      boxShadow: '0 12px 28px rgba(78,52,46,0.24)',
      cursor: 'pointer',
      display: 'none'
    });

    installButton.addEventListener('click', async () => {
      if (!deferredPrompt) {
        return;
      }

      installButton.disabled = true;
      deferredPrompt.prompt();

      await deferredPrompt.userChoice.catch(() => null);

      deferredPrompt = null;
      installButton.style.display = 'none';
      installButton.disabled = false;
    });

    document.body.appendChild(installButton);
    return installButton;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;

    const button = ensureInstallButton();
    button.style.display = 'inline-flex';
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;

    if (installButton) {
      installButton.style.display = 'none';
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(error => {
          console.warn(
            'No se pudo registrar la aplicación instalable:',
            error
          );
        });
    });
  }
})();
