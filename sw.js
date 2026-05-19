self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed & Upgraded');
    self.skipWaiting(); // Forces the new worker to activate immediately
});

self.addEventListener('activate', (e) => {
    console.log('Service Worker: Activated');
    return self.clients.claim(); // Take control of all open tabs
});

self.addEventListener('fetch', (e) => {
    e.respondWith(fetch(e.request));
});

// Watch for the teacher tapping the notification on their phone
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Close the popup
    
    // Open the teacher portal or bring the background tab to the front
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(windowClients => {
            if (windowClients.length > 0) {
                windowClients[0].focus();
            } else {
                clients.openWindow('/');
            }
        })
    );
});
