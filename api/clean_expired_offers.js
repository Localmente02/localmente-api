
// api/clean_expired_offers.js

// Importa la libreria Firebase Admin SDK per parlare con Firestore
const admin = require('firebase-admin');

// Variabile globale per il database di Firestore
let db;

// Inizializza Firebase Admin SDK (esattamente come nel webhook.js)
if (!admin.apps.length) {
  let firebaseConfig = null;
  const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (firebaseServiceAccountKey) {
    try {
      firebaseConfig = JSON.parse(firebaseServiceAccountKey);
    } catch (e) {
      try {
        firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
      } catch (e2) {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY: Errore nel parsing:", e2.message);
      }
    }
  }

  if (firebaseConfig) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
      });
      db = admin.firestore();
      console.log("Firebase Admin SDK inizializzato per clean_expired_offers.");
    } catch (initError) {
      console.error("Errore nell'inizializzazione di Firebase Admin SDK:", initError.message);
    }
  } else {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata. Firebase Admin SDK non inizializzato.");
  }
} else {
  db = admin.firestore();
}

// Funzione principale che verrà eseguita da Vercel
module.exports = async (req, res) => {
  // Blocco di sicurezza: solo Vercel Cron può eseguire questa funzione
  // Controlla un "segreto" che imposteremo nelle variabili d'ambiente di Vercel
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn('Tentativo di accesso non autorizzato alla funzione Cron.');
    return res.status(401).json({ error: 'Accesso non autorizzato.' });
  }

  console.log("🚀 Inizio pulizia offerte scadute...");

  if (!db) {
    console.error("DB non inizializzato. Impossibile procedere.");
    return res.status(500).json({ error: "Errore interno del server: DB non pronto." });
  }

  const now = admin.firestore.Timestamp.now();
  let movedOffersCount = 0;
  const batch = db.batch();

  try {
    // 1. Trova tutte le offerte la cui data di fine è passata
    const expiredByDateQuery = db.collection('alimentari_offers').where('endDate', '<', now);
    const expiredByDateSnapshot = await expiredByDateQuery.get();

    expiredByDateSnapshot.forEach(doc => {
      console.log(`⏳ Trovata offerta scaduta per data: ${doc.id}`);
      const offerData = doc.data();
      const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
      
      // Aggiungi l'offerta al "cestino"
      batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Date Expired' });
      // Elimina l'offerta dalla collezione attiva
      batch.delete(doc.ref);
      movedOffersCount++;
    });

    // 2. Trova tutte le offerte con quantità esaurita (quantity <= 0)
    const expiredByQuantityQuery = db.collection('alimentari_offers').where('quantity', '<=', 0);
    const expiredByQuantitySnapshot = await expiredByQuantityQuery.get();
    
    expiredByQuantitySnapshot.forEach(doc => {
      // Controlla se l'abbiamo già spostata per la data, per non fare doppi conteggi
      if (!expiredByDateSnapshot.docs.some(d => d.id === doc.id)) {
        console.log(`🗑️ Trovata offerta con quantità esaurita: ${doc.id}`);
        const offerData = doc.data();
        const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
        
        batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Quantity Depleted' });
        batch.delete(doc.ref);
        movedOffersCount++;
      }
    });

    // Esegui tutte le operazioni in un colpo solo
    if (movedOffersCount > 0) {
      await batch.commit();
      console.log(`✅ Successo! Spostate ${movedOffersCount} offerte nel cestino.`);
    } else {
      console.log("👍 Nessuna offerta scaduta da pulire oggi.");
    }

    // Rispondi con successo
    return res.status(200).json({ success: true, message: `Spostate ${movedOffersCount} offerte nel cestino.` });

  } catch (error) {
    console.error("❌ Errore durante la pulizia delle offerte:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
