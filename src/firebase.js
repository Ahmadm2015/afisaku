import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, writeBatch, deleteDoc } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyBm72AIbQdpmDcuqvl1v0UgcVpep7IgmvY",
  authDomain: "afisaku-b9910.firebaseapp.com",
  projectId: "afisaku-b9910",
  storageBucket: "afisaku-b9910.firebasestorage.app",
  messagingSenderId: "194055399353",
  appId: "1:194055399353:web:44b1ad80b0e3988c91f868",
  measurementId: "G-TYY29W7024",
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)

const COLLECTION = 'afisaku_data'
const CHUNK_SIZE = 200 // max rows per Firestore document (~safe under 1MB)
const MAX_CHUNK_BYTES = 650_000
const MAX_BATCH_WRITES = 450

function estimateBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function chunkRows(rows) {
  const chunks = []
  let current = []
  let currentBytes = 0

  for (const row of rows) {
    const rowBytes = estimateBytes(row)
    if (current.length && (current.length >= CHUNK_SIZE || currentBytes + rowBytes > MAX_CHUNK_BYTES)) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(row)
    currentBytes += rowBytes
  }

  if (current.length) chunks.push(current)
  return chunks
}

async function commitBatch(writes) {
  if (!writes.length) return
  const batch = writeBatch(db)
  writes.forEach((write) => write(batch))
  await batch.commit()
}

// ── CHUNKED GET ─────────────────────────────────────────────────
// Reads the first chunk, then loads known remaining chunks in parallel.
export async function dataGet(key) {
  try {
    const firstSnap = await getDoc(doc(db, COLLECTION, `${key}_0`))
    const results = []

    if (firstSnap.exists()) {
      const first = firstSnap.data()
      const totalChunks = first.totalChunks || 1
      results.push(...(first.items || []))

      if (totalChunks > 1) {
        const reads = []
        for (let i = 1; i < totalChunks; i++) {
          reads.push(getDoc(doc(db, COLLECTION, `${key}_${i}`)))
        }
        const snaps = await Promise.all(reads)
        snaps.forEach((snap) => {
          if (snap.exists()) results.push(...(snap.data().items || []))
        })
      }

      return results
    }

    // Fallback: try old single-doc format for backward compat
    const snap = await getDoc(doc(db, COLLECTION, key))
    if (snap.exists()) return snap.data().items || []
    return results
  } catch (e) {
    console.error('dataGet error:', e)
    return []
  }
}

// ── CHUNKED SET ─────────────────────────────────────────────────
// Splits array into chunks and writes each as separate document
export async function dataSet(key, val) {
  try {
    const chunks = chunkRows(val)
    const updatedAt = new Date().toISOString()

    for (let start = 0; start < chunks.length; start += MAX_BATCH_WRITES) {
      const writes = chunks.slice(start, start + MAX_BATCH_WRITES).map((chunk, offset) => (batch) => {
        const i = start + offset
        batch.set(doc(db, COLLECTION, `${key}_${i}`), {
          key,
          items: chunk,
          chunkIndex: i,
          totalChunks: chunks.length,
          updatedAt
        })
      })
      await commitBatch(writes)
    }

    // Clean up leftover chunks from previous larger upload
    let i = chunks.length
    while (true) {
      const old = await getDoc(doc(db, COLLECTION, `${key}_${i}`))
      if (!old.exists()) break
      await deleteDoc(doc(db, COLLECTION, `${key}_${i}`))
      i++
    }

    // Also delete old single-doc format if exists
    const oldDoc = await getDoc(doc(db, COLLECTION, key))
    if (oldDoc.exists()) await deleteDoc(doc(db, COLLECTION, key))

  } catch (e) {
    console.error('dataSet error:', e)
    throw e
  }
}
