// minerva-core.js - Global Asset for Minerva Study Circle App

document.addEventListener('DOMContentLoaded', () => {
    // 1. Automatically inject the Pull-to-Refresh spinner at the top of the page if missing
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

    // 2. Native-Feel Pull-to-Refresh & Cache Buster Touch Logic
    let pStartY = 0;
    const ptrSpinner = document.getElementById('ptr-spinner');

    window.addEventListener('touchstart', e => {
        // Only register touch if user is at the absolute top of the page
        if (window.scrollY === 0) {
            pStartY = e.touches[0].pageY;
        }
    }, { passive: true });

    window.addEventListener('touchend', e => {
        if (window.scrollY === 0 && pStartY > 0) {
            const pEndY = e.changedTouches[0].pageY;
            
            // If pulled down more than 120 pixels
            if (pEndY > pStartY + 120) { 
                if (ptrSpinner) ptrSpinner.style.height = '45px'; 
                
                // Destroy local cost-saving caches to force fresh Firebase reads
                sessionStorage.removeItem('minerva_struct');
                sessionStorage.removeItem('minerva_timetable');
                sessionStorage.removeItem('minerva_teachers');
                sessionStorage.removeItem('minerva_rooms');
                
                // Hard reload to fetch latest data
                setTimeout(() => window.location.reload(), 800);
            }
        }
        pStartY = 0;
    });
});
