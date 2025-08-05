// File: /api/generate-imagekit-token.js

// Importiamo le librerie necessarie
const admin = require('firebase-admin');
const ImageKit = require('imagekit');

// --- Inizializzazione Firebase Admin ---
// Controlliamo se Firebase è già stato inizializzato per evitare errori
if (!admin.apps.length) {
  // Le credenziali del tuo service account sono prese automaticamente da Vercel 
  // (le imposteremo nel Passo 4 delle istruzioni)
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Corregge la formattazione della chiave
    }),
  });
}
const db = admin.firestore();

// Funzione principale che verrà eseguita da Vercel
module.exports = async (req, res) => {
  // Impostiamo gli header per permettere al nostro sito di chiamare questa funzione
  res.setHeader('Access-Control-Allow-Origin', '*'); // In produzione, dovresti limitarlo al tuo dominio
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Se è una richiesta pre-flight OPTIONS, rispondiamo subito OK
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Recuperiamo le chiavi segrete da Firestore
    const configDoc = await db.collection('config_private').doc('BucTmeGHsIP48iX2a561').get();
    if (!configDoc.exists) {
      throw new Error("Documento di configurazione non trovato in Firestore.");
    }
    const configData = configDoc.data();

    // Estraiamo le chiavi di ImageKit (la chiave privata è necessaria qui!)
    const imagekitPrivateKey = configData.imagekitPrivateKey;
    const imagekitPublicKey = configData.imagekitPublicKey;
    const imagekitUrlEndpoint = configData.imagekitUrlEndpoint;

    if (!imagekitPrivateKey || !imagekitPublicKey || !imagekitUrlEndpoint) {
      throw new Error("Credenziali di ImageKit mancanti nel documento di configurazione.");
    }
    
    // 2. Inizializziamo l'SDK di ImageKit con le chiavi segrete
    const imagekit = new ImageKit({
      privateKey: imagekitPrivateKey,
      publicKey: imagekitPublicKey,
      urlEndpoint: imagekitUrlEndpoint,
    });

    // 3. Generiamo il token di autenticazione
    // Questo token è temporaneo e sicuro da inviare al browser
    const authenticationParameters = imagekit.getAuthenticationParameters();

    // 4. Inviamo il token al browser come risposta JSON
    res.status(200).json(authenticationParameters);

  } catch (error) {
    console.error("Errore nella generazione del token di ImageKit:", error);
    res.status(500).json({ error: 'Impossibile generare il token di autenticazione.', details: error.message });
  }
};
