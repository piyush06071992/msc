const { onCall, HttpsError } = require("firebase-functions/v2/https");

// --- TIMETABLE AI COPILOT FUNCTION ---
exports.timetableCopilot = onCall(async (request) => {
    try {
        const data = request.data;
        const userPrompt = data.prompt;
        const chatHistory = data.history || []; // Previous conversational context
        const currentTimetable = data.currentTimetable || []; // What's currently on the screen
        const contextData = data.contextData || {}; // Teachers, subjects, rooms limits

        // Your shared API key is perfectly safe here on the backend
        const apiKey = "AIzaSyDISD49PETgSqatyTQ8fS2DdMoDfc5kH4Y"; 

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

        // Format history for Gemini API
        const formattedContents = chatHistory.map(msg => ({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.text }]
        }));

        // Add the newest user prompt
        formattedContents.push({
            role: 'user',
            parts: [{ text: `SYSTEM CONTEXT & INSTRUCTIONS:\n${systemInstruction}\n\nUSER PROMPT:\n${userPrompt}` }]
        });

        // Backend call to Gemini
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
