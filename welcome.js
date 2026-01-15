/**
 * BoilerBus - Welcome Modal
 * Shows first-time visitors a disclaimer and PWA install instructions
 */

(function() {
    const STORAGE_KEY = 'boilerbus-welcome-dismissed';

    /**
     * Detect user platform
     */
    function getPlatform() {
        const ua = navigator.userAgent || navigator.vendor || window.opera;

        // Check if already installed as PWA
        if (window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true) {
            return 'pwa';
        }

        // iOS detection
        if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) {
            return 'ios';
        }

        // Android detection
        if (/android/i.test(ua)) {
            return 'android';
        }

        // Desktop
        return 'desktop';
    }

    /**
     * Generate platform-specific PWA install instructions
     */
    function getPWAInstructions(platform) {
        if (platform === 'ios') {
            return `
                <div class="welcome-pwa-tip">
                    <h3>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 18v-6m0 0V6m0 6h6m-6 0H6"/>
                        </svg>
                        Add to Home Screen
                    </h3>
                    <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.85rem;">
                        Install this app for quick access and a better experience.
                    </p>
                    <ol class="welcome-pwa-steps">
                        <li>
                            <span class="step-num">1</span>
                            <span>Tap the <strong>Share</strong> button at the bottom of Safari</span>
                        </li>
                        <li>
                            <span class="step-num">2</span>
                            <span>Scroll down and tap <strong>Add to Home Screen</strong></span>
                        </li>
                        <li>
                            <span class="step-num">3</span>
                            <span>Tap <strong>Add</strong> in the top right</span>
                        </li>
                    </ol>
                </div>
            `;
        }

        if (platform === 'android') {
            return `
                <div class="welcome-pwa-tip">
                    <h3>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 18v-6m0 0V6m0 6h6m-6 0H6"/>
                        </svg>
                        Install App
                    </h3>
                    <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.85rem;">
                        Install this app for quick access and a better experience.
                    </p>
                    <ol class="welcome-pwa-steps">
                        <li>
                            <span class="step-num">1</span>
                            <span>Tap the <strong>menu</strong> button (three dots) in Chrome</span>
                        </li>
                        <li>
                            <span class="step-num">2</span>
                            <span>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong></span>
                        </li>
                        <li>
                            <span class="step-num">3</span>
                            <span>Tap <strong>Install</strong> to confirm</span>
                        </li>
                    </ol>
                </div>
            `;
        }

        // Desktop or already installed - no instructions
        return '';
    }

    /**
     * Show the welcome modal
     */
    function showModal() {
        const modal = document.getElementById('welcome-modal');
        if (!modal) return;

        // Insert platform-specific PWA instructions
        const platform = getPlatform();
        const instructionsContainer = document.getElementById('pwa-instructions');
        if (instructionsContainer) {
            instructionsContainer.innerHTML = getPWAInstructions(platform);
        }

        // Show modal with animation
        modal.classList.remove('hidden');
        // Force reflow for animation
        modal.offsetHeight;
        modal.classList.add('visible');
    }

    /**
     * Hide the welcome modal
     */
    function hideModal(dontShowAgain = false) {
        const modal = document.getElementById('welcome-modal');
        if (!modal) return;

        if (dontShowAgain) {
            localStorage.setItem(STORAGE_KEY, 'true');
        }

        modal.classList.remove('visible');

        // Wait for animation to complete before hiding
        setTimeout(() => {
            modal.classList.add('hidden');
        }, 300);
    }

    /**
     * Initialize welcome modal
     */
    function init() {
        // Check if already dismissed
        if (localStorage.getItem(STORAGE_KEY) === 'true') {
            return;
        }

        // Wait for DOM
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setup);
        } else {
            setup();
        }
    }

    function setup() {
        const modal = document.getElementById('welcome-modal');
        if (!modal) return;

        // Close button (X)
        const closeBtn = modal.querySelector('.welcome-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => hideModal(false));
        }

        // "Got it" button
        const gotItBtn = document.getElementById('welcome-close-btn');
        if (gotItBtn) {
            gotItBtn.addEventListener('click', () => hideModal(false));
        }

        // "Don't show again" button
        const dontShowBtn = document.getElementById('welcome-dont-show');
        if (dontShowBtn) {
            dontShowBtn.addEventListener('click', () => hideModal(true));
        }

        // Close on backdrop click
        const backdrop = modal.querySelector('.welcome-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => hideModal(false));
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('visible')) {
                hideModal(false);
            }
        });

        // Show modal after a short delay (let the app load first)
        setTimeout(showModal, 500);
    }

    // Start
    init();
})();
