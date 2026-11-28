// =====================================================================================
// ONE DEVICE AT A TIME (staff logins)
// staff-login.html saves a new session id on the staff record (currentSessionId) at every login,
// and the same id on this device (localStorage "minervaActiveStaff".sessionId).
// Every staff page watches the staff record live; when another device logs in with the same
// account the id changes and this device is logged out at once with a notice.
// Not used for admin logins (sessionStorage minervaAdminAuth) while the system is in testing.
// =====================================================================================
(function () {
    function isAdminSession() { try { return sessionStorage.getItem("minervaAdminAuth") === "true"; } catch (e) { return false; } }
    function localStaff() { try { return JSON.parse(localStorage.getItem("minervaActiveStaff") || "null"); } catch (e) { return null; } }

    let done = false;
    function logoutHere() {
        if (done) return; done = true;
        try { localStorage.removeItem("minervaActiveStaff"); } catch (e) {}
        try { alert("⚠️ Your account was just logged in on another device.\n\nYou have been logged out here. Only one device can use an account at a time.\nIf this was not you, log in again and change your password."); } catch (e) {}
        window.location.replace("staff-login.html");
    }

    function start(tries) {
        if (isAdminSession()) return;                       // admins: not yet
        const me = localStaff();
        if (!me || !me.uid) return;                         // not a staff login on this page
        if (!window.firebase || !firebase.apps || !firebase.apps.length || !firebase.firestore) {
            if ((tries || 0) < 50) setTimeout(() => start((tries || 0) + 1), 200);   // page still starting Firebase
            return;
        }
        let ref;
        try { ref = firebase.firestore().collection("staff_applications").doc(me.uid); } catch (e) { return; }
        ref.onSnapshot(snap => {
            // ignore answers from this device's offline copy: they can be older than the login
            if (snap.metadata && snap.metadata.fromCache) return;
            if (!snap.exists) return;
            const current = (snap.data() || {}).currentSessionId;
            if (!current) return;                           // nobody holds a session (e.g. after a logout)
            if (current !== me.sessionId) logoutHere();     // another device logged in (or an old login without an id)
        }, err => console.warn("Session check skipped:", err && err.message));
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start(0));
    else start(0);
})();
