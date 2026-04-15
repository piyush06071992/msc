importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Your exact Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyCSXjpko1RN6D4a3yYqFYdsZOfdxord-MQ",
    authDomain: "shop-portal-bbbbb.firebaseapp.com",
    projectId: "shop-portal-bbbbb",
    storageBucket: "shop-portal-bbbbb.firebasestorage.app",
    messagingSenderId: "701377739976",
    appId: "1:701377739976:web:99998220272090e56e79fd"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Handles notifications while the app is closed or in background
messaging.onBackgroundMessage((payload) => {
    console.log('Background Message received: ', payload);
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/logo.png',
        badge: '/logo.png'
    };
    self.registration.showNotification(notificationTitle, notificationOptions);
});
