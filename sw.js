self.addEventListener('install', (e) => {
  console.log('Service Worker: Installed');
  self.skipWaiting(); // Forces the new service worker to activate immediately
});

self.addEventListener('activate', (e) => {
  console.log('Service Worker: Activated');
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch((error) => {
      console.error('Network request failed, but we caught it!', error);
      
      // Instead of crashing Safari, we gracefully return a simple offline response
      return new Response(
        'You are currently offline or experiencing a poor network connection.',
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'text/plain' })
        }
      );
    })
  );
});
