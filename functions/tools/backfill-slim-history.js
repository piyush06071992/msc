#!/usr/bin/env node
// ============================================================================
// ONE-TIME: create slim mirrors for the EXISTING timetable history.
// (New saves are mirrored automatically by the Cloud Function trigger.)
//
// Safe by design:
//   - READS the full history ONE document at a time (no big query that can time out)
//   - WRITES only to the NEW `*_slim` collections; never changes or deletes existing data
//   - RESUMABLE: if it stops, run it again and it continues where it stopped
//   - Only after every document is mirrored AND verified does it write the
//     "ready" switch that makes the lesson planner use the slim copies.
//
// Run in Google Cloud Shell (project shop-portal-bbbbb):
//   node tools/backfill-slim-history.js            -> copy + verify + switch ON (8 documents at a time)
//   node tools/backfill-slim-history.js --run --parallel=12   -> same, 12 at a time
//   node tools/backfill-slim-history.js --off      -> switch OFF (planner goes back to full history instantly)
//   node tools/backfill-slim-history.js --on       -> switch ON again (only if a previous run verified OK)
//   node tools/backfill-slim-history.js --verify   -> re-check mirrors without writing anything
// ============================================================================
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
// Works both from the repo (functions/tools/) and when copied next to slim-history.js
let slimLib;
try { slimLib = require("../slim-history"); } catch (e) { slimLib = require("./slim-history"); }
const { HISTORY_COLLECTIONS, slimCollectionName, toSlim } = slimLib;

admin.initializeApp({ projectId: "shop-portal-bbbbb" });
const db = admin.firestore();
const STATUS_ID = "__status"; // switch document inside each *_slim collection (has no "date", so pages never query it as history)
const mode = process.argv.slice(2).find(a => ["--run", "--off", "--on", "--verify"].includes(a)) || "--run";
// How many documents to copy at the same time (each is one small, independent job).
const PARALLEL = Math.max(1, Math.min(20, parseInt((process.argv.find(a => a.startsWith("--parallel=")) || "--parallel=8").split("=")[1], 10) || 8));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label) {
    for (let attempt = 1; attempt <= 4; attempt++) {
        try { return await fn(); }
        catch (e) {
            if (attempt === 4) throw e;
            console.log(`   retry ${attempt} for ${label}: ${e.message}`);
            await sleep(2000 * attempt);
        }
    }
}

async function setSwitch(col, ready, extra = {}) {
    await db.collection(slimCollectionName(col)).doc(STATUS_ID)
        .set({ ready, updatedAt: Date.now(), ...extra }, { merge: true });
    console.log(`   ${slimCollectionName(col)}: planner switch is now ${ready ? "ON (uses slim copies)" : "OFF (uses full history)"}`);
}

async function verify(col) {
    // Light listing of the source (only small fields), then compare every mirror.
    const src = await withRetry(() => db.collection(col).select("type", "date", "lastUpdated").get(), "list " + col);
    const slimSnap = await withRetry(() => db.collection(slimCollectionName(col)).select("type", "date", "sourceLastUpdated").get(), "list slim");
    const slimById = new Map(slimSnap.docs.filter(d => d.id !== STATUS_ID).map(d => [d.id, d.data()]));
    const problems = [];
    let expected = 0;
    src.docs.forEach(d => {
        const x = d.data();
        const wanted = toSlim({ ...x, schedule: [] }, d.id); // null if this type is not mirrored
        const have = slimById.get(d.id);
        if (wanted) {
            expected++;
            if (!have) problems.push(`missing mirror: ${d.id}`);
            else if (have.type !== x.type || have.date !== (x.date ?? null) || (have.sourceLastUpdated ?? null) !== (x.lastUpdated ?? null))
                problems.push(`out of date mirror: ${d.id}`);
        } else if (have) problems.push(`extra mirror (type not used): ${d.id}`);
        slimById.delete(d.id);
    });
    slimById.forEach((_, id) => problems.push(`mirror without source: ${id}`));
    return { expected, problems };
}

async function backfill(col) {
    const slimCol = slimCollectionName(col);
    const progressFile = path.join(__dirname, `.backfill-progress-${col}.json`);
    const done = new Set(fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : []);

    console.log(`\n=== ${col}  ->  ${slimCol}`);
    const list = await withRetry(() => db.collection(col).select("type").get(), "list " + col);
    const ids = list.docs.map(d => d.id);
    console.log(`   ${ids.length} history documents (${done.size} already done in an earlier run)`);

    const todo = ids.filter(id => !done.has(id));
    console.log(`   copying ${todo.length} documents, ${PARALLEL} at a time...`);
    let next = 0;
    const worker = async () => {
        while (next < todo.length) {
            const id = todo[next++];
            await withRetry(async () => {
                const snap = await db.collection(col).doc(id).get();      // ONE document per job
                const slim = snap.exists ? toSlim(snap.data(), id) : null;
                const ref = db.collection(slimCol).doc(id);
                if (slim) await ref.set(slim); else await ref.delete();
                done.add(id);
                fs.writeFileSync(progressFile, JSON.stringify([...done]));
                process.stdout.write(`   [${done.size}/${ids.length}] ${id}  ${slim ? `${slim.type}, ${slim.slotCount} slots` : "skipped (type not used)"}\n`);
            }, id);
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
}

(async () => {
    for (const col of HISTORY_COLLECTIONS) {
        if (mode === "--off") { await setSwitch(col, false); continue; }

        if (mode === "--run") await backfill(col);

        const { expected, problems } = await verify(col);
        console.log(`   verify ${col}: ${expected} mirrors expected, ${problems.length} problem(s)`);
        problems.slice(0, 20).forEach(p => console.log("     - " + p));

        if (mode === "--verify") continue;
        if (problems.length === 0) await setSwitch(col, true, { verifiedAt: Date.now(), mirrors: expected });
        else {
            await setSwitch(col, false);
            console.log("   Not switching ON. Run this script again (it resumes) and re-check.");
        }
    }
    console.log("\nDone.");
    process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
