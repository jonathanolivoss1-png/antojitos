// MOBILE_INSTALL_MENU_PWA_V1
(function () {
  'use strict';

  const MOBILE_MEDIA_QUERY =
    window.matchMedia('(max-width: 768px)');

  const mobileInstallButton =
    document.getElementById(
      'mobileInstallAppBtn'
    );

  let deferredPrompt = null;
  let desktopInstallButton = null;

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(
      navigator.userAgent
    );
  }

  function isStandalone() {
    return (
      window.matchMedia(
        '(display-mode: standalone)'
      ).matches ||
      window.navigator.standalone === true
    );
  }

  function closeMobileMenu() {
    const mobileMenu =
      document.getElementById(
        'mobileMenu'
      );

    const menuButton =
      document.getElementById(
        'menuBtn'
      );

    mobileMenu?.classList.remove(
      'open'
    );

    menuButton?.setAttribute(
      'aria-expanded',
      'false'
    );
  }

  function showIosInstructions() {
    window.alert(
      'En iPhone abre esta página en Safari y toca: '
      + 'Compartir → Agregar a pantalla de inicio.'
    );
  }

  async function runInstallFlow() {
    if (isStandalone()) {
      return;
    }

    if (deferredPrompt) {
      deferredPrompt.prompt();

      await deferredPrompt.userChoice
        .catch(() => null);

      deferredPrompt = null;
      updateInstallButtons();
      return;
    }

    if (isIosDevice()) {
      showIosInstructions();
      return;
    }

    window.alert(
      'La instalación todavía no está disponible. '
      + 'Abre el menú del navegador y busca '
      + '“Instalar aplicación” o '
      + '“Agregar a pantalla de inicio”.'
    );
  }

  function ensureDesktopInstallButton() {
    if (desktopInstallButton) {
      return desktopInstallButton;
    }

    desktopInstallButton =
      document.createElement(
        'button'
      );

    desktopInstallButton.type =
      'button';

    desktopInstallButton.id =
      'desktopInstallAppBtn';

    desktopInstallButton.textContent =
      'Instalar aplicación';

    desktopInstallButton.setAttribute(
      'aria-label',
      'Instalar Antojitos Los Anafres'
    );

    Object.assign(
      desktopInstallButton.style,
      {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '9998',
        border: 'none',
        borderRadius: '999px',
        padding: '12px 16px',
        background: '#C73E1D',
        color: '#ffffff',
        font:
          '800 14px Nunito, Arial, sans-serif',
        boxShadow:
          '0 12px 28px rgba(78,52,46,0.24)',
        cursor: 'pointer',
        display: 'none'
      }
    );

    desktopInstallButton.addEventListener(
      'click',
      () => {
        void runInstallFlow();
      }
    );

    document.body.appendChild(
      desktopInstallButton
    );

    return desktopInstallButton;
  }

  function shouldShowMobileInstall() {
    if (
      !MOBILE_MEDIA_QUERY.matches ||
      isStandalone()
    ) {
      return false;
    }

    return (
      isIosDevice() ||
      Boolean(deferredPrompt)
    );
  }

  function shouldShowDesktopInstall() {
    return (
      !MOBILE_MEDIA_QUERY.matches &&
      !isStandalone() &&
      Boolean(deferredPrompt)
    );
  }

  function updateInstallButtons() {
    if (mobileInstallButton) {
      mobileInstallButton.classList.toggle(
        'hidden',
        !shouldShowMobileInstall()
      );
    }

    const desktopButton =
      ensureDesktopInstallButton();

    desktopButton.style.display =
      shouldShowDesktopInstall()
        ? 'inline-flex'
        : 'none';
  }

  mobileInstallButton?.addEventListener(
    'click',
    () => {
      closeMobileMenu();
      void runInstallFlow();
    }
  );

  window.addEventListener(
    'beforeinstallprompt',
    event => {
      event.preventDefault();
      deferredPrompt = event;
      updateInstallButtons();
    }
  );

  window.addEventListener(
    'appinstalled',
    () => {
      deferredPrompt = null;
      updateInstallButtons();
    }
  );

  if (
    typeof MOBILE_MEDIA_QUERY.addEventListener ===
    'function'
  ) {
    MOBILE_MEDIA_QUERY.addEventListener(
      'change',
      updateInstallButtons
    );
  } else {
    MOBILE_MEDIA_QUERY.addListener(
      updateInstallButtons
    );
  }

  updateInstallButtons();

  if ('serviceWorker' in navigator) {
    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker
          .register(
            '/sw.js',
            {
              updateViaCache: 'none'
            }
          )
          .then(registration => {
            void registration.update();
          })
          .catch(error => {
            console.warn(
              'No se pudo registrar la aplicación instalable:',
              error
            );
          });
      }
    );
  }
})();
