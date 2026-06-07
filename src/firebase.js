import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore'

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

export async function dataGet(key) {
  try {
    const snap = await getDoc(doc(db, COLLECTION, key))
    return snap.exists() ? (snap.data().items || []) : []
  } catch (e) {
    console.error('dataGet error:', e)
    return []
  }
}

export async function dataSet(key, val) {
  try {
    await setDoc(doc(db, COLLECTION, key), {
      items: val,
      updatedAt: new Date().toISOString()
    })
  } catch (e) {
    console.error('dataSet error:', e)
  }
}
