importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Initialize the Firebase app in the service worker
firebase.initializeApp({
    apiKey: "AIzaSyCSXjpko1RN6D4a3yYqFYdsZOfdxord-MQ",
    authDomain: "shop-portal-bbbbb.firebaseapp.com",
    projectId: "shop-portal-bbbbb",
    storageBucket: "shop-portal-bbbbb.firebasestorage.app",
    messagingSenderId: "701377739976",
    appId: "1:701377739976:web:99998220272090e56e79fd"
});

// Retrieve an instance of Firebase Messaging so that it can handle background messages.
const messaging = firebase.messaging();
