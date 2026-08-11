const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// =======================================================
// --- 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
// =======================================================
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata",
    region: "asia-south1" // Matches Mumbai / Firestore
}, async (event) => {
    
    // 1. TIMEZONE SYNC: Force evaluation in IST
    const utcDate = new Date();
    const istString = utcDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);
    
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = daysArr[istDate.getDay()];
    
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const todayIso = `${year}-${month}-${day}`;

    // =======================================================
    // 2. COST-SAVING GATEKEEPER (Zero Database Reads)
    // =======================================================
    const currentHour = istDate.getHours();
    const currentDayNum = istDate.getDay(); // 0 is Sunday

    // A. Sunday Check
    if (currentDayNum === 0) {
        console.log("[Gatekeeper] Sunday detected. System sleeping to save costs.");
        return null; // Kills function instantly
    }

    // B. Outside Operating Hours Check
    // Earliest class is 8:15 AM (Cron needs to run at 8:05 AM -> Hour 8)
    // Latest class is 5:00 PM (Cron needs to run at 4:50 PM -> Hour 16)
    if (currentHour < 8 || currentHour >= 17) {
        console.log(`[Gatekeeper] Out of operating hours (${currentHour}:00). System sleeping to save costs.`);
        return null; // Kills function instantly
    }
    // =======================================================
    
    // 3. CRITICAL FIX: "TIME SNAPPING" TO FIX CRON DELAYS
    const actualMins = istDate.getHours() * 60 + istDate.getMinutes();
    
    // Snaps 15:31, 15:32, 15:33, or 15:34 down to exactly 15:30
    const snappedCurrentMins = Math.floor(actualMins / 5) * 5; 
    const targetMins = snappedCurrentMins + 10; 

    const targetHour = Math.floor(targetMins / 60).toString().padStart(2, '0');
    const targetMinute = (targetMins % 60).toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMinute}`;

    console.log(`[Reminders] Executed at ${istDate.getHours()}:${istDate.getMinutes()}. Snapped Target: ${targetTimeStr}`);

    try {
        let notifications = [];
        const branches = [
            { prefix: "", name: "Ghumarwin" },
            { prefix: "dharamshala_", name: "Dharamshala" }
        ];

        for (const branch of branches) {
            const historyCol = `${branch.prefix}timetable_history`;
            const masterCol = `${branch.prefix}timetable`;
            
            let branchSchedule = [];
            let isOverride = false;

            const historyDoc = await admin.firestore().collection(historyCol).doc(todayIso).get();
            if (historyDoc.exists) {
                const hData = historyDoc.data();
                if (hData.type === "DAILY_OVERRIDE" || hData.type === "EXAM_OVERRIDE") {
                    isOverride = true;
                    branchSchedule = hData.schedule || [];
                    console.log(`[Reminders] Found active OVERRIDE for ${branch.name}.`);
                }
            }

            if (isOverride) {
                const targetSlots = branchSchedule.filter(slot => 
                    slot.day === currentDay && 
                    slot.start24 === targetTimeStr
                );
                
                targetSlots.forEach(slot => {
                    if ((slot.teacherEmail || slot.teacherName || slot.teacher) && slot.subject) {
                        notifications.push({
                            teacherEmail: slot.teacherEmail || "",
                            teacherName: slot.teacherName || slot.teacher || "",
                            subject: slot.subject,
                            className: slot.className,
                            section: slot.section,
                            timeRange: slot.timeRange || targetTimeStr,
                            branch: branch.name
                        });
                    }
                });
            } else {
                const ttSnap = await admin.firestore().collection(masterCol)
                    .where("day", "==", currentDay)
                    .where("start24", "==", targetTimeStr)
                    .get();

                ttSnap.forEach(doc => {
                    const slot = doc.data();
                    if ((slot.teacherEmail || slot.teacherName || slot.teacher) && slot.subject) {
                        notifications.push({
                            teacherEmail: slot.teacherEmail || "",
                            teacherName: slot.teacherName || slot.teacher || "",
                            subject: slot.subject,
                            className: slot.className,
                            section: slot.section,
                            timeRange: slot.timeRange || targetTimeStr,
                            branch: branch.name
                        });
                    }
                });
            }
        }

        if (notifications.length === 0) {
            console.log("[Reminders] No matching classes found for this window.");
            return null;
        }

        console.log(`[Reminders] Found ${notifications.length} classes. Processing push alerts...`);

        for (let notif of notifications) {
            let staffSnap = null;
            
            if (notif.teacherEmail) {
                staffSnap = await admin.firestore().collection("staff_applications")
                    .where("email", "==", notif.teacherEmail)
                    .get();
            }

            if ((!staffSnap || staffSnap.empty) && notif.teacherName) {
                staffSnap = await admin.firestore().collection("staff_applications").get();
            }

            let targetToken = null;
            let latestTokenTime = 0;

            if (staffSnap && !staffSnap.empty) {
                staffSnap.forEach(staffDoc => {
                    const staffData = staffDoc.data();
                    const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
                    const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
                    
                    if (
                        (notif.teacherEmail && staffData.email === notif.teacherEmail) ||
                        (notif.teacherName && staffFullName.toLowerCase() === notif.teacherName.toLowerCase())
                    ) {
                        if (staffData.fcmToken) {
                            const tokenTime = staffData.tokenUpdatedAt || 0;
                            if (tokenTime >= latestTokenTime) {
                                targetToken = staffData.fcmToken;
                                latestTokenTime = tokenTime;
                            }
                        }
                    }
                });
            }

            if (targetToken) {
                const message = {
                    token: targetToken,
                    notification: {
                        title: "🔔 Class Starting in 10 Mins!",
                        body: `Your lecture for ${notif.subject} (Class ${notif.className} - Sec ${notif.section}) starts at ${notif.timeRange}.`
                    },
                    webpush: {
                        headers: {
                            Urgency: "high"
                        },
                        notification: {
                            requireInteraction: true,
                            vibrate: [300, 100, 300, 100, 300, 100, 500]
                        },
                        fcmOptions: {
                            link: "https://minervaacademy.web.app/teacher-portal.html" 
                        }
                    }
                };
                await admin.messaging().send(message);
                console.log(`[Reminders] Successfully alerted ${notif.teacherName || notif.teacherEmail}`);
            }
        }
    } catch (error) {
        console.error("[Reminders] Error:", error);
    }

    return null;
});

// =======================================================
// --- INSTANT TIMETABLE UPDATE ALERTS ---
// Fires immediately when Admin saves timetable changes
// =======================================================
exports.sendInstantPushAlerts = onDocumentCreated({
    document: "instant_alerts/{docId}",
    region: "asia-south1" // Explicitly locked to Mumbai to match Firestore
}, async (event) => {
    const data = event.data.data();
    const teachers = data.teachers || [];

    if (teachers.length === 0) return null;

    let tokens = [];

    // Loop through the affected teachers to find their device tokens
    for (let t of teachers) {
        if (!t.name && !t.email) continue;
        
        let staffSnap;
        if (t.email) {
             staffSnap = await admin.firestore().collection("staff_applications").where("email", "==", t.email).get();
        } else if (t.name) {
             staffSnap = await admin.firestore().collection("staff_applications").get();
        }

        if (!staffSnap || staffSnap.empty) continue;

        let targetToken = null;
        let latestTokenTime = 0;

        staffSnap.forEach(doc => {
            const staffData = doc.data();
            const nameKey = Object.keys(staffData.details || {}).find(k => k.toLowerCase().includes('name'));
            const staffFullName = nameKey ? staffData.details[nameKey] : (staffData.name || "");
            
            if (
                (t.email && staffData.email === t.email) ||
                (t.name && staffFullName.toLowerCase() === t.name.toLowerCase())
            ) {
                if (staffData.fcmToken) {
                    const tokenTime = staffData.tokenUpdatedAt || 0;
                    if (tokenTime >= latestTokenTime) {
                        targetToken = staffData.fcmToken;
                        latestTokenTime = tokenTime;
                    }
                }
            }
        });
        
        // Prevent sending duplicate notifications to the same device
        if (targetToken && !tokens.includes(targetToken)) {
            tokens.push(targetToken);
        }
    }

    if (tokens.length === 0) {
        console.log("[Instant Alerts] No active tokens found for affected teachers.");
        return null;
    }

    // Build the Multicast Payload
    const message = {
        notification: {
            title: "🚨 Timetable Updated!",
            body: "The Admin has modified your upcoming schedule. Please tap to view your updated duties."
        },
        webpush: {
            headers: { Urgency: "high" },
            notification: {
                requireInteraction: true,
                vibrate: [300, 100, 300, 100, 300, 100, 500]
            },
            fcmOptions: {
                link: "https://minervaacademy.web.app/teacher-portal.html"
            }
        },
        tokens: tokens // Send to all affected teachers simultaneously
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`[Instant Alerts] Sent to ${tokens.length} devices. Success: ${response.successCount}, Fails: ${response.failureCount}`);
    } catch (error) {
        console.error("[Instant Alerts] Error sending multicast:", error);
    }

    return null;
});
