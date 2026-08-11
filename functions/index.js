const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// --- 1. TIMETABLE AI COPILOT FUNCTION ---
exports.timetableCopilot = onCall(async (request) => {
    try {
        const data = request.data;
        const userPrompt = data.prompt;
        const chatHistory = data.history || []; 
        const currentTimetable = data.currentTimetable || []; 
        const contextData = data.contextData || {}; 

        const apiKey = ""; // Keep your Gemini API key safe here

        if (!userPrompt) {
            throw new Error('Prompt is missing from the request.');
        }

        const systemInstruction = `You are the Minerva Timetable AI Copilot. You interact directly with the school admin to build and modify the live timetable JSON data.

AVAILABLE RESOURCES:
- Teachers: ${contextData.teachers || "None specified"}
- Subjects: ${contextData.subjects || "None specified"}
- Rooms: ${contextData.rooms || "None specified"}

CURRENT TIMETABLE STATE (JSON):
${JSON.stringify(currentTimetable)}

RULES:
1. Act as a timetable algorithm. Calculate times accurately (e.g. 45 mins from 09:00 is 09:45).
2. ONLY modify or add to the current timetable state based on the user's prompt. Do NOT delete existing blocks unless asked.
3. You MUST return the ENTIRE updated JSON array containing both the untouched old blocks and your new/modified blocks.
4. Detect clashes. If the user creates a clash (e.g. assigning a teacher to two places at the same time), still make the change in the JSON, but warn them politely in the "reply" string.
5. You MUST return your response strictly as a JSON object adhering to this exact schema (no markdown, no backticks, raw JSON only):

{
  "reply": "Your conversational response here.",
  "new_timetable_data": [
    {
      "day": "Monday",
      "className": "10",
      "section": "A",
      "start24": "09:00",
      "end24": "09:45",
      "timeRange": "09:00 AM - 09:45 AM",
      "duration": "45 MINS",
      "subject": "MATHEMATICS",
      "teacher": "NEEL KAMAL",
      "teacherName": "NEEL KAMAL",
      "teacherEmail": "",
      "room": "",
      "remark": "",
      "sMins": 540,
      "eMins": 585
    }
  ]
}`;

        const formattedContents = chatHistory.map(msg => ({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.text }]
        }));

        formattedContents.push({
            role: 'user',
            parts: [{ text: `SYSTEM CONTEXT & INSTRUCTIONS:\n${systemInstruction}\n\nUSER PROMPT:\n${userPrompt}` }]
        });

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: formattedContents,
                generationConfig: { 
                    response_mime_type: "application/json",
                    temperature: 0.1
                }
            })
        });

        const aiResult = await response.json();
        
        if (!response.ok) {
            console.error("Gemini API Rejected:", aiResult);
            throw new Error(aiResult.error?.message || "Gemini API rejected the request.");
        }

        let jsonText = aiResult.candidates[0].content.parts[0].text;
        jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

        return JSON.parse(jsonText);

    } catch (error) {
        console.error("Timetable Copilot error:", error);
        throw new HttpsError('internal', "Failed: " + error.message);
    }
});


// --- 2. 10-MINUTE PRE-CLASS REMINDER CRON JOB ---
exports.sendPreClassReminders = onSchedule({
    schedule: "every 5 minutes",
    timeZone: "Asia/Kolkata"
}, async (event) => {
    const now = new Date();
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = daysArr[now.getDay()];
    
    // Calculate current time in total minutes since midnight
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const targetMins = currentMins + 10; // Target classes starting in 10 minutes

    const targetHour = Math.floor(targetMins / 60).toString().padStart(2, '0');
    const targetMinute = (targetMins % 60).toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMinute}`;

    try {
        // Query timetable slots for today matching the target start time
        const ttSnap = await admin.firestore().collection("timetable")
            .where("day", "==", currentDay)
            .where("start24", "==", targetTimeStr)
            .get();

        if (ttSnap.empty) return null;

        let notifications = [];
        ttSnap.forEach(doc => {
            const slot = doc.data();
            if (slot.teacherEmail && slot.subject) {
                notifications.push({
                    teacherEmail: slot.teacherEmail,
                    subject: slot.subject,
                    className: slot.className,
                    section: slot.section
                });
            }
        });

        // Send free FCM push notification to each matching teacher
        for (let notif of notifications) {
            const staffSnap = await admin.firestore().collection("staff_applications")
                .where("email", "==", notif.teacherEmail)
                .get();

            if (!staffSnap.empty) {
                const staffData = staffSnap.docs[0].data();
                if (staffData.fcmToken) {
                    const message = {
                        token: staffData.fcmToken,
                        notification: {
                            title: "🔔 Class Starting in 10 Mins!",
                            body: `Your lecture for ${notif.subject} (Class ${notif.className} - Sec ${notif.section}) starts at ${targetTimeStr}.`
                        }
                    };
                    await admin.messaging().send(message);
                }
            }
        }
    } catch (error) {
        console.error("Error executing pre-class reminders:", error);
    }

    return null;
});
