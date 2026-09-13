// minerva-core.js - Optimized for Android WebViews
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
