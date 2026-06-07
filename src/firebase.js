import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, writeBatch, deleteDoc, query, where } from 'firebase/firestore'

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

// ── CHUNKED GET ─────────────────────────────────────────────────
// Reads all chunks: key_0, key_1, key_2, ... until no more found
export async function dataGet(key) {
  try {
    const results = []
    let i = 0
    while (true) {
      const snap = await getDoc(doc(db, COLLECTION, `${key}_${i}`))
      if (!snap.exists()) break
      const items = snap.data().items || []
      results.push(...items)
      i++
      if (items.length < CHUNK_SIZE) break // last chunk
    }
    // Fallback: try old single-doc format for backward compat
    if (results.length === 0) {
      const snap = await getDoc(doc(db, COLLECTION, key))
      if (snap.exists()) return snap.data().items || []
    }
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
    const chunks = []
    for (let i = 0; i < val.length; i += CHUNK_SIZE) {
      chunks.push(val.slice(i, i + CHUNK_SIZE))
    }

    // Write all chunks
    const batch = writeBatch(db)
    chunks.forEach((chunk, i) => {
      batch.set(doc(db, COLLECTION, `${key}_${i}`), {
        items: chunk,
        chunkIndex: i,
        totalChunks: chunks.length,
        updatedAt: new Date().toISOString()
      })
    })

    // Delete any old extra chunks (if new data is smaller)
    await batch.commit()

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
  }
}
