// minerva-core.js - Optimized for Android WebViews
(async function enforcePortalVersion() {
    const APP_VERSION = "2026.11.19.2"; // Bump this whenever you want all devices to clear old caches
    const savedVersion = localStorage.getItem("minerva_app_version");

    if (savedVersion !== APP_VERSION) {
        const activeStaff = localStorage.getItem("minervaActiveStaff");
        const adminAuth = sessionStorage.getItem("minervaAdminAuth");
        const adminCenter = sessionStorage.getItem("minervaAdminCenter");

        localStorage.clear();
        sessionStorage.clear();

        if (activeStaff) localStorage.setItem("minervaActiveStaff", activeStaff);
        if (adminAuth) sessionStorage.setItem("minervaAdminAuth", adminAuth);
        if (adminCenter) sessionStorage.setItem("minervaAdminCenter", adminCenter);

        if ("caches" in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            } catch (e) {}
        }

        if (window.indexedDB && indexedDB.databases) {
            try {
                const dbs = await indexedDB.databases();
                await Promise.all(
                    dbs.map((dbInfo) => {
                        if (!dbInfo.name) return Promise.resolve();
                        return new Promise((resolve) => {
                            const req = indexedDB.deleteDatabase(dbInfo.name);
                            req.onsuccess = resolve;
                            req.onerror = resolve;
                            req.onblocked = resolve;
                        });
                    })
                );
            } catch (e) {}
        }

        localStorage.setItem("minerva_app_version", APP_VERSION);
        window.location.reload();
        return;
    }
})();

document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('ptr-spinner')) {
        const spinnerDiv = document.createElement('div');
        spinnerDiv.id = 'ptr-spinner';
        spinnerDiv.className = 'w-full h-0 overflow-hidden flex items-center justify-center bg-slate-100 transition-all duration-300 fixed top-0 left-0 z-[99999] shadow-sm';
        spinnerDiv.innerHTML = `
            <div class="flex items-center py-2">
                <span class="loader border-slate-300 border-t-blue-600 w-4 h-4 inline-block animate-spin rounded-full border-2"></span>
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-600 ml-3 font-sans">Syncing Live Data...</span>
            </div>
        `;
        document.body.insertBefore(spinnerDiv, document.body.firstChild);
    }

    let pStartY = 0;
    const ptrSpinner = document.getElementById('ptr-spinner');

    window.addEventListener('touchstart', e => {
        if (window.pageYOffset <= 5 || document.documentElement.scrollTop <= 5) {
            pStartY = e.touches[0].pageY;
        } else {
            pStartY = 0;
        }
    }, { passive: true });

    window.addEventListener('touchend', e => {
        if (pStartY > 0) {
            const pEndY = e.changedTouches[0].pageY;
            if (pEndY > pStartY + 100) {
                if (ptrSpinner) ptrSpinner.style.height = '45px';

                // Wipe all session storage caches across the app
                sessionStorage.clear();

                setTimeout(() => window.location.reload(), 600);
            }
        }
        pStartY = 0;
    });
});
