importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// 1. INITIALIZE FIREBASE
firebase.initializeApp({
    apiKey: "AIzaSyCSXjpko1RN6D4a3yYqFYdsZOfdxord-MQ",
    authDomain: "shop-portal-bbbbb.firebaseapp.com",
    projectId: "shop-portal-bbbbb",
    storageBucket: "shop-portal-bbbbb.firebasestorage.app",
    messagingSenderId: "701377739976",
    appId: "1:701377739976:web:99998220272090e56e79fd"
});

const messaging = firebase.messaging();

// 2. FIREBASE BACKGROUND NOTIFICATION LISTENER
messaging.onBackgroundMessage(function(payload) {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);

    const notificationTitle = payload.notification.title || "Minerva Alert";
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/logo.png', // Ensure this matches your actual logo file name
        vibrate: [300, 100, 300, 100, 300, 100, 500],
        requireInteraction: true,
        data: { 
            url: "https://minervaacademy.web.app/teacher-portal.html" 
        }
    };

    // Forces Android to show the banner
    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// 3. NOTIFICATION CLICK HANDLER
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});

// =========================================================
// 4. YOUR PWA OFFLINE LOGIC (Merged from sw.js)
// =========================================================

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
