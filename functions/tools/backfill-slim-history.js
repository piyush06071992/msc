#!/usr/bin/env node
// ============================================================================
// ONE-TIME: create slim mirrors for the EXISTING timetable history.
// (New saves are mirrored automatically by the Cloud Function trigger.)
//
// Safe by design:
//   - READS the full history ONE document at a time (no big query that can time out)
//   - WRITES only to the NEW `*_slim` collections; never changes or deletes existing data
//   - RESUMABLE: if it stops, run it again; it only copies mirrors that are missing or out of date
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
const admin = require("firebase-admin");
// Works both from the repo (functions/tools/) and when copied next to slim-history.js
let slimLib;
try { slimLib = require("../slim-history"); } catch (e) { slimLib = require("./slim-history"); }
const { HISTORY_COLLECTIONS, slimCollectionName, toSlim, SLIM_FORMAT_VERSION } = slimLib;

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

// A mirror is up to date when it exists in the current format and matches the source's
// type, date and lastUpdated. Lists use select() so the big timetables are NOT downloaded.
async function compare(col) {
    const src = await withRetry(() => db.collection(col).select("type", "date", "lastUpdated").get(), "list " + col);
    const slimSnap = await withRetry(() => db.collection(slimCollectionName(col)).select("type", "date", "sourceLastUpdated", "format").get(), "list slim");
    const slimById = new Map(slimSnap.docs.filter(d => d.id !== STATUS_ID).map(d => [d.id, d.data()]));
    const toCopy = [], toDelete = [], problems = [];
    src.docs.forEach(d => {
        const x = d.data();
        const have = slimById.get(d.id);
        if (!have) { toCopy.push(d.id); problems.push(`missing mirror: ${d.id}`); }
        else if (have.format !== SLIM_FORMAT_VERSION || (have.type ?? null) !== (x.type ?? null) || (have.date ?? null) !== (x.date ?? null)
                 || (have.sourceLastUpdated ?? null) !== (x.lastUpdated ?? null)) {
            toCopy.push(d.id); problems.push(`out of date mirror: ${d.id}`);
        }
        slimById.delete(d.id);
    });
    slimById.forEach((_, id) => { toDelete.push(id); problems.push(`mirror without source: ${id}`); });
    return { expected: src.size, toCopy, toDelete, problems };
}

async function backfill(col) {
    const slimCol = slimCollectionName(col);
    console.log(`\n=== ${col}  ->  ${slimCol}`);
    const { expected, toCopy, toDelete } = await compare(col);
    console.log(`   ${expected} history documents, ${expected - toCopy.length} already up to date, ${toCopy.length} to copy`);
    for (const id of toDelete) await withRetry(() => db.collection(slimCol).doc(id).delete(), "delete " + id);
    if (toCopy.length) console.log(`   copying ${toCopy.length} documents, ${PARALLEL} at a time...`);
    let next = 0, n = 0;
    const worker = async () => {
        while (next < toCopy.length) {
            const id = toCopy[next++];
            await withRetry(async () => {
                const snap = await db.collection(col).doc(id).get();      // ONE document per job
                const slim = snap.exists ? toSlim(snap.data(), id) : null;
                const ref = db.collection(slimCol).doc(id);
                if (slim) await ref.set(slim); else await ref.delete();
                n++;
                process.stdout.write(`   [${n}/${toCopy.length}] ${id}  ${slim ? `${slim.type}, ${slim.slotCount} slots` : "source gone, mirror removed"}\n`);
            }, id);
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
}

(async () => {
    for (const col of HISTORY_COLLECTIONS) {
        if (mode === "--off") { await setSwitch(col, false); continue; }

        if (mode === "--run") await backfill(col);

        const { expected, problems } = await compare(col);
        console.log(`   verify ${col}: ${expected} mirrors expected, ${problems.length} problem(s)`);
        problems.slice(0, 20).forEach(p => console.log("     - " + p));

        if (mode === "--verify") continue;
        if (problems.length === 0) await setSwitch(col, true, { verifiedAt: Date.now(), mirrors: expected, format: SLIM_FORMAT_VERSION });
        else {
            await setSwitch(col, false);
            console.log("   Not switching ON. Run this script again (it resumes) and re-check.");
        }
    }
    console.log("\nDone.");
    process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
