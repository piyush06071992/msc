import os
import sys
import threading
import csv
import io
import fitz
import cv2
import numpy as np
from flask import Flask, request, jsonify, render_template_string, Response
import webview

app = Flask(__name__)

# Embedded clean desktop UI with CSV download integration
UI_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Minerva Professional OMR Scanner</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="bg-slate-100 font-sans p-6">
    <div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-8 border border-slate-200">
        <h1 class="text-2xl font-black text-slate-900 mb-1">OMR Office Batch Scanner</h1>
        <p class="text-slate-500 text-sm mb-6">Upload office ADF scanner PDF to evaluate and export CSV instantly.</p>
        
        <div class="flex flex-col gap-4">
            <label class="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center cursor-pointer hover:bg-slate-50 transition">
                <span class="text-sm font-bold text-slate-700 block mb-1">Select Room ADF Scanned PDF</span>
                <input type="file" id="pdfFile" accept=".pdf" class="hidden" onchange="updateFileName(this)">
                <span id="fileName" class="text-xs text-blue-600 font-medium">No file chosen</span>
            </label>

            <button onclick="processPDF()" id="processBtn" class="bg-blue-600 hover:bg-blue-700 text-white font-black py-3 rounded-xl shadow-lg transition uppercase text-xs tracking-wider">
                Start OMR Evaluation
            </button>
        </div>

        <div id="resultsContainer" class="mt-6 hidden">
            <div class="flex justify-between items-center mb-3">
                <span id="statusText" class="text-sm font-bold text-slate-800"></span>
                <button onclick="downloadCSV()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-xs font-black uppercase shadow">
                    📥 Download CSV Report
                </button>
            </div>
            <div id="previewList" class="bg-slate-50 border border-slate-200 rounded-xl p-4 max-h-60 overflow-y-auto text-xs font-mono space-y-1"></div>
        </div>
    </div>

    <script>
        let evaluatedResults = [];

        function updateFileName(input) {
            if(input.files[0]) {
                document.getElementById('fileName').innerText = input.files[0].name;
            }
        }

        async function processPDF() {
            const fileInput = document.getElementById('pdfFile');
            if(!fileInput.files[0]) {
                alert('Please select a PDF file first!');
                return;
            }

            const btn = document.getElementById('processBtn');
            btn.innerText = "Processing Scans Locally...";
            btn.disabled = true;

            const formData = new FormData();
            formData.append('pdf', fileInput.files[0]);

            try {
                const res = await fetch('/evaluate-local', { method: 'POST', body: formData });
                const data = await res.json();
                
                if(data.success) {
                    evaluatedResults = data.results;
                    document.getElementById('resultsContainer').classList.remove('hidden');
                    document.getElementById('statusText').innerText = `Successfully evaluated ${data.evaluatedCount} pages!`;
                    
                    let previewHTML = '';
                    evaluatedResults.forEach(r => {
                        let ansCount = Object.keys(r.responses).length;
                        previewHTML += `<div>Roll: <strong>${r.rollNo}</strong> | Answered: ${ansCount} questions</div>`;
                    });
                    document.getElementById('previewList').innerHTML = previewHTML;
                } else {
                    alert('Error: ' + data.error);
                }
            } catch(e) {
                alert('Processing failed: ' + e.message);
            } finally {
                btn.innerText = "Start OMR Evaluation";
                btn.disabled = false;
            }
        }

        function downloadCSV() {
            if(evaluatedResults.length === 0) return;
            let csv = 'RollNumber,Question,SelectedOption\\n';
            evaluatedResults.forEach(r => {
                for(let [q, ans] of Object.entries(r.responses)) {
                    csv += `${r.rollNo},${q},${ans}\\n`;
                }
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.setAttribute('href', url);
            a.setAttribute('download', 'omr_results.csv');
            a.click();
        }
    </script>
</body>
</html>
"""

def warp_perspective_to_standard(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 120, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    anchor_candidates = []
    for c in contours:
        area = cv2.contourArea(c)
        if 100 < area < 3000:
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) == 4:
                (x, y, w, h) = cv2.boundingRect(approx)
                if 0.8 <= (w / float(h)) <= 1.2:
                    anchor_candidates.append([x + w/2.0, y + h/2.0])

    h_img, w_img, _ = img.shape
    if len(anchor_candidates) < 4:
        pts = np.float32([[50, 50], [w_img - 50, 50], [w_img - 50, h_img - 50], [50, h_img - 50]])
    else:
        pts = np.array(anchor_candidates, dtype="float32")
        s = pts.sum(axis=1)
        rect = np.zeros((4, 2), dtype="float32")
        rect[0] = pts[np.argmin(s)]
        rect[2] = pts[np.argmax(s)]
        diff = np.diff(pts, axis=1)
        rect[1] = pts[np.argmin(diff)]
        rect[3] = pts[np.argmax(diff)]
        pts = rect

    target_w, target_h = 1240, 1754
    dst = np.float32([[0, 0], [target_w, 0], [target_w, target_h], [0, target_h]])
    M = cv2.getPerspectiveTransform(pts, dst)
    return cv2.warpPerspective(img, M, (target_w, target_h))

@app.route('/')
def index():
    return render_template_string(UI_HTML)

@app.route('/evaluate-local', methods=['POST'])
def evaluate_local():
    try:
        pdf_file = request.files['pdf']
        file_bytes = pdf_file.read()
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        results = []

        for page_num in range(len(doc)):
            page = doc[page_num]
            pix = page.get_pixmap(dpi=150)
            img_path = f"/tmp/page_{page_num}.png"
            pix.save(img_path)

            raw_img = cv2.imread(img_path)
            warped_img = warp_perspective_to_standard(raw_img)
            gray_warped = cv2.cvtColor(warped_img, cv2.COLOR_BGR2GRAY)

            responses = {}
            start_x, col_width, start_y, row_step, opt_spacing, bubble_radius = 90, 370, 330, 14.2, 14.0, 5
            question_counter = 1

            for col in range(3):
                curr_x = start_x + (col * col_width)
                for row in range(50):
                    curr_y = start_y + (row * row_step)
                    option_darkness = []
                    for opt in range(1, 5):
                        opt_x = int(curr_x + 45 + ((opt - 1) * opt_spacing))
                        opt_y_val = int(curr_y)
                        try:
                            roi_gray = gray_warped[opt_y_val - bubble_radius:opt_y_val + bubble_radius, opt_x - bubble_radius:opt_x + bubble_radius]
                            if roi_gray.size > 0:
                                _, thresh_roi = cv2.threshold(roi_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
                                dark_pixels = np.sum(thresh_roi == 255)
                                option_darkness.append(dark_pixels / roi_gray.size)
                            else:
                                option_darkness.append(0.0)
                        except:
                            option_darkness.append(0.0)

                    max_darkness = max(option_darkness)
                    avg_others = sum(option_darkness) / 4.0
                    if max_darkness > 0.18 and max_darkness > (avg_others * 1.3):
                        responses[str(question_counter)] = str(option_darkness.index(max_darkness) + 1)
                    question_counter += 1

            results.append({
                "rollNo": f"2026{str(page_num + 1).zfill(3)}",
                "responses": responses
            })

        return jsonify({"success": True, "evaluatedCount": len(results), "results": results})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

def start_flask():
    app.run(host='127.0.0.1', port=57123, debug=False, use_reloader=False)

if __name__ == '__main__':
    t = threading.Thread(target=start_flask)
    t.daemon = True
    t.start()
    webview.create_window("Minerva Professional OMR Scanner", "http://127.0.0.1:57123", width=900, height=750)
    webview.start()
